import { lstat, realpath } from 'node:fs/promises';
import { createConnection, type Socket } from 'node:net';
import { dirname, isAbsolute } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import {
  qualifiedInspectionRequestSchema, qualifiedInspectionResponseSchema, sha256Schema,
  type QualifiedInspectionReceipt, type QualifiedInspectionRequest, type QualifiedInspectionResponse,
} from '@itervane/contracts';
import { scannerProfiles, sha256 } from './profiles.js';
import { sourcePath } from './snapshot.js';

const requestLimit = 2048;
const responseLimit = 4 * 1024 * 1024 + 8192;
const heartbeatMs = 450;

export type QualifiedControllerAddress = {
  socketPath: string; controllerUid: number; imageSha256: string;
};

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
}

function verifyReceipt(receipt: QualifiedInspectionReceipt, request: QualifiedInspectionRequest, imageSha256: string) {
  const { origin, ...scope } = request;
  const { snapshot } = receipt;
  if (Object.entries(scope).some(([key, value]) => receipt.scope[key as keyof typeof scope] !== value)
      || receipt.imageSha256 !== imageSha256 || receipt.originSha256 !== sha256(origin)
      || receipt.domainId !== snapshot.runId || snapshot.commit !== request.commit || snapshot.repositoryId !== request.repositoryId) {
    throw new Error('runner_receipt_binding');
  }
  for (const [index, expected] of scannerProfiles.entries()) {
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

export class QualifiedInspectionClient {
  private readonly imageSha256: string;
  constructor(private readonly address: QualifiedControllerAddress) {
    this.imageSha256 = sha256Schema.parse(address.imageSha256);
  }

  async inspect(
    rawRequest: QualifiedInspectionRequest, authorize: () => Promise<void>, signal?: AbortSignal,
  ): Promise<QualifiedInspectionResponse> {
    const request = qualifiedInspectionRequestSchema.parse(rawRequest);
    const requestFrame = Buffer.from(JSON.stringify(request) + '\n');
    let admitted = false;
    const unavailable = (): QualifiedInspectionResponse => ({
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
    const cancel = () => {
      if (!done.signal.aborted && !socket.destroyed) socket.write('C');
      done.abort();
    };
    const pulse = async () => {
      while (!done.signal.aborted) {
        try { await authorize(); }
        catch { cancel(); return; }
        if (done.signal.aborted || signal?.aborted) { cancel(); return; }
        admitted = true;
        socket.write('K');
        await delay(heartbeatMs, undefined, { signal: done.signal }).catch(() => undefined);
      }
    };
    try {
      socket.write(requestFrame);
      const first = await lines.read(requestLimit);
      clearTimeout(handshake);
      if (first !== 'READY 1') {
        const rejected = qualifiedInspectionResponseSchema.parse(JSON.parse(first));
        if (rejected.kind !== 'rejected' || rejected.requestId !== request.requestId || rejected.cleanup !== 'not_started') throw new Error('runner_handshake');
        return rejected;
      }
      signal?.addEventListener('abort', cancel, { once: true });
      if (signal?.aborted) cancel();
      else void pulse();
      const response = qualifiedInspectionResponseSchema.parse(JSON.parse(await lines.read(responseLimit)));
      if (response.kind === 'receipt') verifyReceipt(response, request, this.imageSha256);
      else if (response.requestId !== request.requestId) throw new Error('runner_response_id');
      return response;
    } catch {
      return unavailable();
    } finally {
      done.abort();
      signal?.removeEventListener('abort', cancel);
      clearTimeout(overall);
      clearTimeout(handshake);
      socket.destroy();
    }
  }
}
