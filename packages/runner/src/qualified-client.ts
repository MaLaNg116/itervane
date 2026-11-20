import { lstat, realpath } from 'node:fs/promises';
import { createConnection, type Socket } from 'node:net';
import { dirname, isAbsolute } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import {
  qualifiedInspectionRequestSchema, qualifiedInspectionResponseSchema, qualifiedInspectionStatusSchema, qualifiedRunnerRejectionSchema,
  qualifiedRepairObservationRequestSchema, qualifiedRepairObservationResponseSchema,
  qualifiedRepairRequestSchema, qualifiedRepairResponseSchema, sha256Schema,
  type QualifiedInspectionReceipt, type QualifiedInspectionRequest, type QualifiedInspectionResponse,
  type InspectionPlan, type QualifiedInspectionScope, type QualifiedInspectionStatus,
  type QualifiedRepairReceipt, type QualifiedRepairRequest, type QualifiedRepairResponse, type RepairPatch, type RepairWorkspace,
  type QualifiedRepairObservationReceipt, type QualifiedRepairObservationRequest, type QualifiedRepairObservationResponse,
  type RepairObservationWorkspace, type RepairTarget,
} from '@itervane/contracts';
import { scannerProfiles, sha256 } from './profiles.js';
import { canonicalRepairCommand, canonicalRepairObservation, protectedRepairPath } from './repair-command.js';
import { sourcePath } from './snapshot.js';

const requestLimit = 2048;
const responseLimit = 4 * 1024 * 1024 + 8192;
const repairResponseLimit = 32 * 1024;
const heartbeatMs = 450;

export type QualifiedControllerAddress = {
  socketPath: string; controllerUid: number; imageSha256: string;
};
type Rejected = Extract<QualifiedInspectionResponse, { kind: 'rejected' }>;
type RepairCoordinates = Omit<QualifiedRepairRequest, 'operation' | 'commandBytes' | 'commandSha256'>;
type RepairRequest = QualifiedRepairRequest | QualifiedRepairObservationRequest;
type RepairReceipt = QualifiedRepairReceipt | QualifiedRepairObservationReceipt;

class Lines {
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
      const next = await this.iterator.next();
      if (next.done || !Buffer.isBuffer(next.value)) throw new Error('runner_frame_missing');
      this.pending = next.value;
    }
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
  for (const [index, expected] of profiles.entries()) {
    const report = snapshot.reports[index]!;
    if (report.scanner !== expected.scanner || report.version !== expected.version || report.policySha256 !== expected.policySha256
        || report.snapshotSha256 !== snapshot.manifestSha256) throw new Error('runner_receipt_profile');
    const ids = new Set<string>();
    for (const finding of report.findings) {
      const path = sourcePath(finding.path);
      if (ids.has(finding.id) || finding.id !== sha256(JSON.stringify([report.scanner, snapshot.manifestSha256, finding.ruleId, path, finding.line]))) {
        throw new Error('runner_receipt_finding');
      }
      ids.add(finding.id);
    }
  }
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
}

export class QualifiedInspectionClient {
  private readonly imageSha256: string;
  constructor(private readonly address: QualifiedControllerAddress) {
    this.imageSha256 = sha256Schema.parse(address.imageSha256);
  }

  async observe(signal?: AbortSignal): Promise<QualifiedInspectionStatus | null> {
    if (signal?.aborted) return null;
    try { await verifySocket(this.address); }
    catch { return null; }
    const socket = createConnection(this.address.socketPath);
    const lines = new Lines(socket);
    const stop = () => socket.destroy();
    const deadline = setTimeout(stop, 6_000);
    signal?.addEventListener('abort', stop, { once: true });
    try {
      if (signal?.aborted) return null;
      socket.write('STATUS 1\n');
      const status = qualifiedInspectionStatusSchema.parse(JSON.parse(await lines.read(requestLimit)));
      return status.imageSha256 === this.imageSha256 ? status : null;
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

  private async execute<Response extends QualifiedInspectionResponse | QualifiedRepairResponse | QualifiedRepairObservationResponse>(
    request: QualifiedInspectionRequest | RepairRequest, authorize: () => Promise<void>, signal: AbortSignal | undefined,
    decode: (line: string) => Response, command?: Buffer,
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
    const lines = new Lines(socket);
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
      const response = decode(await lines.read(command ? repairResponseLimit : responseLimit));
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
