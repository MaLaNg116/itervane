import { createHash } from 'node:crypto';
import { lstat, mkdtemp, open, realpath, rm } from 'node:fs/promises';
import { createConnection, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import {
  npmRegistryTarball, npmRepairPaths,
  qualifiedInspectionRequestSchema, qualifiedInspectionResponseSchema, qualifiedInspectionStatusSchema, qualifiedRunnerRejectionSchema,
  qualifiedRepairObservationRequestSchema, qualifiedRepairObservationResponseSchema,
  qualifiedRepairRequestSchema, qualifiedRepairResponseSchema, sha256Schema,
  qualifiedImageArchiveSchema, qualifiedOciArchiveVerificationSchema, type QualifiedImageArchive, type QualifiedOciArchiveVerification,
  qualifiedVerificationRequestSchema, qualifiedVerificationResponseSchema, verificationProofByteLimit, type FormalVerificationInput,
  type QualifiedInspectionReceipt, type QualifiedInspectionRequest, type QualifiedInspectionResponse,
  type InspectionPlan, type QualifiedInspectionScope, type QualifiedInspectionStatus,
  type QualifiedRepairReceipt, type QualifiedRepairRequest, type QualifiedRepairResponse, type RepairPatch, type RepairWorkspace,
  type QualifiedRepairObservationReceipt, type QualifiedRepairObservationRequest, type QualifiedRepairObservationResponse,
  type RepairObservationWorkspace, type RepairTarget,
  type QualifiedVerificationReceipt, type QualifiedVerificationRequest, type QualifiedVerificationResponse,
} from '@itervane/contracts';
import { scannerProfiles, sha256 } from './profiles.js';
import { canonicalRepairCommand, canonicalRepairObservation, protectedRepairPath } from './repair-command.js';
import { scanFindingId } from './scan-finding-id.js';
import { sourcePath } from './snapshot.js';
import { canonicalVerificationCommand } from './verification-command.js';

const requestLimit = 2048;
const responseLimit = 4 * 1024 * 1024 + 8192;
const repairResponseLimit = 32 * 1024;
const heartbeatMs = 450;
const archiveTransferMs = 66_000;

export type QualifiedControllerAddress = {
  socketPath: string; controllerUid: number; imageSha256: string;
};
type Rejected = Extract<QualifiedInspectionResponse, { kind: 'rejected' }>;
type RepairCoordinates = Omit<QualifiedRepairRequest, 'operation' | 'commandBytes' | 'commandSha256'>;
type RepairRequest = QualifiedRepairRequest | QualifiedRepairObservationRequest;
type RepairReceipt = QualifiedRepairReceipt | QualifiedRepairObservationReceipt;
type VerificationCoordinates = Pick<QualifiedVerificationRequest, 'requestId' | 'fence' | 'workspaceSha256' | 'origin'>;
type VerificationCommand = ReturnType<typeof canonicalVerificationCommand>;

class SocketReader {
  private readonly iterator;
  private pending: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  constructor(socket: Socket) { this.iterator = socket[Symbol.asyncIterator](); }

  async read(maximum: number) {
    const chunks: Buffer[] = [];
    let total = 0;
    while (true) {
      const end = this.pending.indexOf(10);
      const part = end < 0 ? this.pending : this.pending.subarray(0, end);
      total += part.length;
      if (total > maximum) throw new Error('runner_frame_limit');
      if (part.length) chunks.push(part);
      if (end >= 0) {
        this.pending = this.pending.subarray(end + 1);
        return Buffer.concat(chunks, total).toString('utf8');
      }
      await this.fill();
    }
  }

  async *readBytes(size: number) {
    let remaining = size;
    while (remaining > 0) {
      if (!this.pending.length) await this.fill();
      const chunk = this.pending.subarray(0, remaining);
      this.pending = this.pending.subarray(chunk.length);
      remaining -= chunk.length;
      yield chunk;
    }
  }

  async requireEnd() {
    if (this.pending.length || !(await this.iterator.next()).done) throw new Error('runner_unexpected_bytes');
  }

  private async fill() {
    const next = await this.iterator.next();
    if (next.done || !Buffer.isBuffer(next.value)) throw new Error('runner_frame_missing');
    this.pending = next.value;
  }
}

async function verifySocket(address: QualifiedControllerAddress) {
  const { socketPath, controllerUid } = address;
  const uid = process.getuid?.();
  if (process.platform !== 'linux' || !uid || uid === controllerUid || !Number.isInteger(controllerUid)
      || controllerUid <= 0 || !isAbsolute(socketPath) || Buffer.byteLength(socketPath) > 100) throw new Error('runner_address');
  const parent = dirname(socketPath);
  const [canonical, directory, file] = await Promise.all([realpath(parent), lstat(parent), lstat(socketPath)]);
  if (parent !== canonical || !directory.isDirectory() || directory.uid !== controllerUid || (directory.mode & 0o022)
      || !file.isSocket() || file.uid !== controllerUid || (file.mode & 0o002)) throw new Error('runner_address');
  for (let path = parent; dirname(path) !== path;) {
    path = dirname(path);
    const ancestor = await lstat(path);
    if (!ancestor.isDirectory() || (ancestor.uid !== 0 && ancestor.uid !== controllerUid)
        || (ancestor.mode & 0o022)) throw new Error('runner_address');
  }
}

export function verifyQualifiedInspectionReceipt(receipt: QualifiedInspectionReceipt,
  scope: QualifiedInspectionScope, binding: { imageSha256: string; originSha256: string },
  profiles: readonly InspectionPlan['scanners'][number][] = scannerProfiles) {
  const { snapshot } = receipt;
  if (Object.entries(scope).some(([key, value]) => receipt.scope[key as keyof typeof scope] !== value)
      || receipt.imageSha256 !== binding.imageSha256 || receipt.originSha256 !== binding.originSha256
      || receipt.domainId !== snapshot.runId || snapshot.commit !== scope.commit || snapshot.repositoryId !== scope.repositoryId) {
    throw new Error('runner_receipt_binding');
  }
  verifyReportBindings(snapshot.reports, snapshot.manifestSha256, profiles);
}

function verifyReportBindings(reports: QualifiedInspectionReceipt['snapshot']['reports'], manifestSha256: string,
  profiles: readonly InspectionPlan['scanners'][number][] = scannerProfiles) {
  for (const [index, expected] of profiles.entries()) {
    const report = reports[index]!;
    if (report.scanner !== expected.scanner || report.version !== expected.version || report.policySha256 !== expected.policySha256
        || report.snapshotSha256 !== manifestSha256) throw new Error('runner_receipt_profile');
    const ids = new Set<string>();
    for (const finding of report.findings) {
      const path = sourcePath(finding.path);
      if (ids.has(finding.id) || finding.id !== scanFindingId(report.scanner, manifestSha256, { ...finding, path })) {
        throw new Error('runner_receipt_finding');
      }
      ids.add(finding.id);
    }
  }
}

export function verifyQualifiedVerificationReceipt(receipt: QualifiedVerificationReceipt, request: QualifiedVerificationRequest,
  command: VerificationCommand) {
  const { origin, ...scope } = request;
  const { snapshot } = receipt;
  const { subject, inspection, source, profile, taskId, runId, projectId, generation } = command.input;
  const bindings = { taskId, runId, projectId, generation, ...source, verificationInputSha256: command.inputSha256,
    baseSnapshotSha256: inspection.snapshotSha256, targetManifestSha256: subject.manifestSha256,
    runnerImageSha256: profile.runnerImageSha256, scannerInputsSha256: profile.scannerInputsSha256,
    buildProfileSha256: profile.buildProfileSha256,
    runStandardBaseline: profile.runStandardBaseline,
    ociInputsSha256: profile.ociInputsSha256,
    retainStandardImage: profile.retainStandardImage,
    commandSha256: sha256(command.bytes), commandBytes: command.bytes.length,
  };
  if (Object.entries(bindings).some(([key, value]) => scope[key as keyof typeof bindings] !== value)) {
    throw new Error('runner_verification_request_binding');
  }
  if (Object.entries(scope).some(([key, value]) => receipt.scope[key as keyof typeof scope] !== value)
      || receipt.imageSha256 !== scope.runnerImageSha256 || receipt.originSha256 !== sha256(origin)
      || receipt.domainId !== snapshot.runId || snapshot.commit !== scope.commit || snapshot.repositoryId !== scope.repositoryId
      || snapshot.manifestSha256 !== scope.baseSnapshotSha256 || snapshot.commandSha256 !== scope.commandSha256
      || snapshot.verificationInputSha256 !== command.inputSha256 || snapshot.inputsSha256 !== scope.scannerInputsSha256) {
    throw new Error('runner_verification_receipt_binding');
  }
  const build = snapshot.build;
  if (receipt.scope.buildProfileSha256 !== scope.buildProfileSha256
      || build?.buildProfileSha256 !== scope.buildProfileSha256 || (build
      && (build.runId !== receipt.domainId || build.verificationInputSha256 !== scope.verificationInputSha256
        || build.subjectManifestSha256 !== subject.manifestSha256 || build.baselineSha256 !== profile.baselineSha256))) {
    throw new Error('runner_standard_build_binding');
  }
  const baseline = build?.status === 'built' ? build.baseline : undefined;
  if (receipt.scope.runStandardBaseline !== scope.runStandardBaseline
      || Boolean(baseline) !== Boolean(scope.runStandardBaseline && build?.status === 'built')
      || (baseline && (baseline.baselineSha256 !== profile.baselineSha256
        || build?.status !== 'built' || baseline.distSha256 !== build.dist.sha256))) {
    throw new Error('runner_standard_baseline_binding');
  }
  const image = baseline?.status === 'passed' ? baseline.image : undefined;
  if (receipt.scope.ociInputsSha256 !== scope.ociInputsSha256
      || Boolean(image) !== Boolean(scope.ociInputsSha256 && baseline?.status === 'passed')
      || (image && image.ociInputsSha256 !== scope.ociInputsSha256)) {
    throw new Error('runner_standard_image_binding');
  }
  const sourceDatabase = snapshot.reports[1].database;
  if (image?.status === 'scanned' && (image.scan.database.sha256 !== sourceDatabase?.sha256
      || image.scan.database.updatedAt !== sourceDatabase.updatedAt)) {
    throw new Error('runner_standard_image_scan_binding');
  }
  if (receipt.scope.retainStandardImage !== scope.retainStandardImage
      || (image?.status === 'scanned' && Boolean(image.archive) !== Boolean(scope.retainStandardImage))) {
    throw new Error('runner_standard_image_archive_binding');
  }
  const target = snapshot.target;
  if (subject.kind === 'repair'
    ? target?.patchSha256 !== subject.patchSha256 || target?.manifestSha256 !== subject.manifestSha256
    : target !== null || snapshot.manifestSha256 !== subject.manifestSha256) throw new Error('runner_verification_target_binding');
  verifyReportBindings(snapshot.reports, snapshot.manifestSha256);
  if (build?.status === 'built'
      && [...snapshot.reports, ...(target?.reports ?? [])].some(report => report.status !== 'completed')) {
    throw new Error('runner_standard_build_coverage');
  }
  if (target) {
    const difference = command.repair!.patch.files.flatMap(file => file.edits).reduce((total, edit) =>
      total + Buffer.byteLength(edit.replacement) - (edit.endByte - edit.startByte), 0);
    if (target.totalBytes !== snapshot.totalBytes + difference) throw new Error('runner_verification_target_binding');
    verifyReportBindings(target.reports, target.manifestSha256);
    if (snapshot.reports[1].database && target.reports[1].database
      && snapshot.reports[1].database.sha256 !== target.reports[1].database.sha256) throw new Error('runner_verification_database_binding');
  }
}

export function prepareQualifiedVerificationRequest(coordinates: VerificationCoordinates, command: VerificationCommand) {
  const { taskId, runId, projectId, generation, source, profile, inspection, subject } = command.input;
  return qualifiedVerificationRequestSchema.parse({
    ...coordinates, version: 1, operation: 'verify_source', taskId, runId, projectId, generation, ...source,
    verificationInputSha256: command.inputSha256, baseSnapshotSha256: inspection.snapshotSha256,
    targetManifestSha256: subject.manifestSha256, runnerImageSha256: profile.runnerImageSha256, scannerInputsSha256: profile.scannerInputsSha256,
    ...(profile.buildProfileSha256 ? { buildProfileSha256: profile.buildProfileSha256 } : {}),
    ...(profile.runStandardBaseline ? { runStandardBaseline: profile.runStandardBaseline } : {}),
    ...(profile.ociInputsSha256 ? { ociInputsSha256: profile.ociInputsSha256 } : {}),
    ...(profile.retainStandardImage ? { retainStandardImage: profile.retainStandardImage } : {}),
    commandSha256: sha256(command.bytes), commandBytes: command.bytes.length,
  });
}

function requireRepairSource(receipt: RepairReceipt, request: RepairRequest, imageSha256: string) {
  const { origin, ...scope } = request;
  const { snapshot } = receipt;
  if (Object.entries(scope).some(([key, value]) => receipt.scope[key as keyof typeof scope] !== value)
      || receipt.imageSha256 !== imageSha256 || receipt.originSha256 !== sha256(origin)
      || receipt.domainId !== snapshot.runId || snapshot.commit !== scope.commit || snapshot.repositoryId !== scope.repositoryId
      || snapshot.manifestSha256 !== scope.baseSnapshotSha256 || snapshot.commandSha256 !== scope.commandSha256) {
    throw new Error('runner_repair_receipt_binding');
  }
}

function requireRepairWorkspace(fixed: RepairObservationWorkspace, request: RepairRequest) {
  if (fixed.operationId !== request.operationId || fixed.repairInputSha256 !== request.repairInputSha256
      || fixed.source.repositoryId !== request.repositoryId || fixed.source.commit !== request.commit
      || fixed.baseSnapshotSha256 !== request.baseSnapshotSha256) throw new Error('runner_repair_request_binding');
}

export function verifyQualifiedRepairReceipt(receipt: QualifiedRepairReceipt, request: QualifiedRepairRequest,
  command: ReturnType<typeof canonicalRepairCommand>, imageSha256: string) {
  requireRepairSource(receipt, request, imageSha256);
  const { candidate } = receipt.snapshot;
  if (candidate.operationId !== request.operationId || candidate.repairInputSha256 !== request.repairInputSha256
      || candidate.baseSnapshotSha256 !== request.baseSnapshotSha256 || candidate.patchSha256 !== command.patchSha256
      || candidate.workspaceSha256 !== command.workspaceSha256 || candidate.changes.length !== command.patch.files.length) {
    throw new Error('runner_repair_receipt_binding');
  }
  for (const [index, change] of candidate.changes.entries()) {
    const file = command.patch.files[index]!;
    const difference = file.edits.reduce((total, edit) => total + Buffer.byteLength(edit.replacement) - (edit.endByte - edit.startByte), 0);
    if (change.path !== file.path || change.beforeSha256 !== file.beforeSha256 || change.edits !== file.edits.length
        || file.edits.some(edit => edit.endByte > change.beforeBytes) || change.afterBytes !== change.beforeBytes + difference) {
      throw new Error('runner_repair_receipt_change');
    }
  }
}

export function verifyQualifiedRepairObservation(receipt: QualifiedRepairObservationReceipt, request: QualifiedRepairObservationRequest,
  command: ReturnType<typeof canonicalRepairObservation>, imageSha256: string) {
  requireRepairSource(receipt, request, imageSha256);
  const { observation } = receipt.snapshot;
  if (observation.operationId !== request.operationId || observation.repairInputSha256 !== request.repairInputSha256
      || observation.baseSnapshotSha256 !== request.baseSnapshotSha256 || observation.targets.length !== command.targets.length
      || observation.targets.some(({ findingId, path, scanner, line, status }, index) => {
        const target = command.targets[index]!;
        return target.findingId !== findingId || target.path !== path || target.scanner !== scanner || target.line !== line
          || protectedRepairPath(path, command.workspace.protectedPaths) !== (status === 'protected');
      })) throw new Error('runner_repair_observation_binding');
  for (const { findingId, path, npm } of observation.targets) {
    if (!npm) continue;
    const scope = command.workspace.npmRepairs?.find(entry => entry.findingId === findingId);
    if (!scope) throw new Error('runner_repair_npm_binding');
    const paths = npmRepairPaths(scope.lockPath);
    const { name, installedVersion, fixedVersion, integrity } = scope.approval;
    if (!paths.some(expected => expected === path) || npm.name !== name || npm.installedVersion !== installedVersion
      || npm.fixedVersion !== fixedVersion || !paths.every(expected => observation.targets.some(peer => peer.findingId === findingId
        && peer.path === expected && peer.npm))) throw new Error('runner_repair_npm_binding');
    const version = JSON.stringify(fixedVersion);
    const replacements = npm.edits.map(edit =>
      edit.startByte === edit.endByte && edit.replacement === `, "integrity": ${JSON.stringify(integrity)}` ? JSON.stringify(integrity) : edit.replacement);
    const permitted = path === scope.lockPath
      ? [version, version, JSON.stringify(npmRegistryTarball(name, fixedVersion)), JSON.stringify(integrity)] : [version];
    if (JSON.stringify(replacements.sort()) !== JSON.stringify(permitted.sort())) throw new Error('runner_repair_npm_binding');
  }
}

export class QualifiedInspectionClient {
  private readonly imageSha256: string;
  constructor(private readonly address: QualifiedControllerAddress) {
    this.imageSha256 = sha256Schema.parse(address.imageSha256);
  }

  async observe(signal?: AbortSignal): Promise<QualifiedInspectionStatus | null> {
    return this.readObservation('STATUS 1\n', signal, value => {
      const status = qualifiedInspectionStatusSchema.parse(value);
      return status.imageSha256 === this.imageSha256 ? status : null;
    });
  }

  async verifyArchive(raw: QualifiedImageArchive, signal?: AbortSignal): Promise<QualifiedOciArchiveVerification | null> {
    const archive = qualifiedImageArchiveSchema.parse(raw);
    return this.readObservation(`ARCHIVE 1 ${archive.sha256} ${archive.bytes}\n`, signal, value => {
      const verified = qualifiedOciArchiveVerificationSchema.parse(value);
      if (verified.runnerImageSha256 !== this.imageSha256 || verified.archive.sha256 !== archive.sha256
          || verified.archive.bytes !== archive.bytes) return null;
      return verified;
    });
  }

  async withRetainedArchive<T>(raw: QualifiedOciArchiveVerification, authorize: () => Promise<void>,
    use: (archivePath: string) => Promise<T>, signal?: AbortSignal): Promise<T> {
    const expected = qualifiedOciArchiveVerificationSchema.parse(raw);
    if (expected.runnerImageSha256 !== this.imageSha256) throw new Error('runner_archive_image_binding');
    signal?.throwIfAborted();
    await verifySocket(this.address);
    const directory = await mkdtemp(join(tmpdir(), 'itervane-release-'));
    const path = join(directory, 'image.oci.tar');
    try {
      await this.receiveArchive(expected, path, authorize, signal);
      signal?.throwIfAborted();
      return await use(path);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }

  private async receiveArchive(expected: QualifiedOciArchiveVerification, path: string,
    authorize: () => Promise<void>, signal?: AbortSignal) {
    const deadline = AbortSignal.timeout(archiveTransferMs);
    const active = signal ? AbortSignal.any([signal, deadline]) : deadline;
    const { archive } = expected;
    active.throwIfAborted();
    const socket = createConnection(this.address.socketPath);
    const reader = new SocketReader(socket);
    const cancel = () => socket.destroy();
    active.addEventListener('abort', cancel, { once: true });
    try {
      active.throwIfAborted();
      socket.write(`ARCHIVE_READ 1 ${archive.sha256} ${archive.bytes}\n`);
      if (await reader.read(requestLimit) !== `ARCHIVE_READY 1 ${this.imageSha256}`) throw new Error('runner_archive_handshake');
      await authorize();
      active.throwIfAborted();
      const file = await open(path, 'wx', 0o600);
      try {
        active.throwIfAborted();
        socket.write('K');
        const digest = createHash('sha256');
        let recheckAt = performance.now() + heartbeatMs;
        for await (const chunk of reader.readBytes(archive.bytes)) {
          if (performance.now() >= recheckAt) {
            await authorize();
            recheckAt = performance.now() + heartbeatMs;
          }
          active.throwIfAborted();
          digest.update(chunk);
          await file.writeFile(chunk);
        }
        if (digest.digest('hex') !== archive.sha256) throw new Error('runner_archive_digest');
        const receipt = qualifiedOciArchiveVerificationSchema.parse(JSON.parse(await reader.read(requestLimit)));
        if (receipt.runnerImageSha256 !== this.imageSha256 || receipt.archive.sha256 !== archive.sha256
            || receipt.archive.bytes !== archive.bytes) throw new Error('runner_archive_receipt');
        await reader.requireEnd();
        await file.chmod(0o400);
      } finally { await file.close(); }
      // The staged file is still private. Revalidate before any consumer can access it.
      active.throwIfAborted();
      await authorize();
      active.throwIfAborted();
    } finally {
      active.removeEventListener('abort', cancel);
      cancel();
    }
  }

  private async readObservation<T>(request: string, signal: AbortSignal | undefined, decode: (value: unknown) => T): Promise<T | null> {
    if (signal?.aborted) return null;
    try { await verifySocket(this.address); }
    catch { return null; }
    const socket = createConnection(this.address.socketPath);
    const lines = new SocketReader(socket);
    const stop = () => socket.destroy();
    const deadline = setTimeout(stop, 6_000);
    signal?.addEventListener('abort', stop, { once: true });
    try {
      if (signal?.aborted) return null;
      socket.write(request);
      return decode(JSON.parse(await lines.read(requestLimit)));
    } catch {
      return null;
    } finally {
      signal?.removeEventListener('abort', stop);
      clearTimeout(deadline);
      stop();
    }
  }

  async inspect(
    rawRequest: QualifiedInspectionRequest, authorize: () => Promise<void>, signal?: AbortSignal,
  ): Promise<QualifiedInspectionResponse> {
    const request = qualifiedInspectionRequestSchema.parse(rawRequest);
    return this.execute(request, authorize, signal, line => {
      const response = qualifiedInspectionResponseSchema.parse(JSON.parse(line));
      if (response.kind === 'receipt') {
        const { origin, ...scope } = request;
        verifyQualifiedInspectionReceipt(response, scope, { imageSha256: this.imageSha256, originSha256: sha256(origin) });
      }
      return response;
    });
  }

  async repair(rawRequest: RepairCoordinates, workspace: RepairWorkspace, patch: RepairPatch,
    authorize: () => Promise<void>, signal?: AbortSignal): Promise<QualifiedRepairResponse> {
    const command = canonicalRepairCommand(workspace, patch);
    const request = qualifiedRepairRequestSchema.parse({ ...rawRequest, operation: 'apply_repair',
      commandSha256: sha256(command.bytes), commandBytes: command.bytes.length });
    requireRepairWorkspace(command.workspace, request);
    return this.execute(request, authorize, signal, line => {
      const response = qualifiedRepairResponseSchema.parse(JSON.parse(line));
      if (response.kind === 'repair_receipt') verifyQualifiedRepairReceipt(response, request, command, this.imageSha256);
      return response;
    }, command.bytes);
  }

  async observeRepair(rawRequest: RepairCoordinates, workspace: RepairObservationWorkspace, targets: readonly RepairTarget[],
    authorize: () => Promise<void>, signal?: AbortSignal): Promise<QualifiedRepairObservationResponse> {
    const command = canonicalRepairObservation({ workspace, targets });
    const request = qualifiedRepairObservationRequestSchema.parse({ ...rawRequest, operation: 'observe_repair',
      commandSha256: sha256(command.bytes), commandBytes: command.bytes.length });
    requireRepairWorkspace(command.workspace, request);
    return this.execute(request, authorize, signal, line => {
      const response = qualifiedRepairObservationResponseSchema.parse(JSON.parse(line));
      if (response.kind === 'repair_observation') verifyQualifiedRepairObservation(response, request, command, this.imageSha256);
      return response;
    }, command.bytes);
  }

  async verify(coordinates: VerificationCoordinates, input: FormalVerificationInput, repair: VerificationCommand['repair'],
    authorize: () => Promise<void>, signal?: AbortSignal): Promise<QualifiedVerificationResponse> {
    const command = canonicalVerificationCommand({ input, repair });
    const request = prepareQualifiedVerificationRequest(coordinates, command);
    if (request.runnerImageSha256 !== this.imageSha256) throw new Error('runner_verification_image_binding');
    return this.execute(request, authorize, signal, line => {
      const response = qualifiedVerificationResponseSchema.parse(JSON.parse(line));
      if (response.kind === 'verification_receipt') verifyQualifiedVerificationReceipt(response, request, command);
      return response;
    }, command.bytes, verificationProofByteLimit + 8192);
  }

  private async execute<Response extends QualifiedInspectionResponse | QualifiedRepairResponse | QualifiedRepairObservationResponse | QualifiedVerificationResponse>(
    request: QualifiedInspectionRequest | RepairRequest | QualifiedVerificationRequest, authorize: () => Promise<void>, signal: AbortSignal | undefined,
    decode: (line: string) => Response, command?: Buffer,
    maximum = command ? repairResponseLimit : responseLimit,
  ): Promise<Response | Rejected> {
    const requestFrame = Buffer.from(JSON.stringify(request) + '\n');
    let admitted = false;
    const unavailable = (): Rejected => ({
      kind: 'rejected', requestId: request.requestId, domainId: null,
      code: admitted ? 'cleanup_unproven' : 'not_ready', cleanup: admitted ? 'unknown' : 'not_started',
    });
    if (requestFrame.length > requestLimit || signal?.aborted) return unavailable();
    try { await verifySocket(this.address); }
    catch { return unavailable(); }

    const socket = createConnection(this.address.socketPath);
    const lines = new SocketReader(socket);
    const done = new AbortController();
    const overall = setTimeout(() => socket.destroy(), 190_000);
    const handshake = setTimeout(() => socket.destroy(), 6_000);
    let pulses: Promise<void> | undefined;
    const cancel = () => {
      if (!done.signal.aborted && !socket.destroyed) socket.write('C');
      done.abort();
    };
    const pulse = async () => {
      while (!done.signal.aborted) {
        try { await authorize(); }
        catch { cancel(); return; }
        if (done.signal.aborted || signal?.aborted) { cancel(); return; }
        const initial = !admitted;
        admitted = true;
        socket.write('K');
        if (initial && command) socket.write(command);
        await delay(heartbeatMs, undefined, { signal: done.signal }).catch(() => undefined);
      }
    };
    try {
      socket.write(requestFrame);
      const first = await lines.read(requestLimit);
      clearTimeout(handshake);
      if (first !== 'READY 1') {
        const rejected = qualifiedRunnerRejectionSchema.parse(JSON.parse(first));
        if (rejected.requestId !== request.requestId || rejected.cleanup !== 'not_started' || rejected.domainId) throw new Error('runner_handshake');
        return rejected;
      }
      signal?.addEventListener('abort', cancel, { once: true });
      if (signal?.aborted) cancel();
      else pulses = pulse();
      const response = decode(await lines.read(maximum));
      if (response.kind === 'rejected' && (response.requestId !== request.requestId || (response.cleanup === 'confirmed' && !response.domainId)
          || (response.cleanup === 'not_started' && response.domainId))) throw new Error('runner_response_binding');
      return response;
    } catch {
      return unavailable();
    } finally {
      done.abort();
      signal?.removeEventListener('abort', cancel);
      clearTimeout(overall);
      clearTimeout(handshake);
      socket.destroy();
      await pulses;
    }
  }
}
