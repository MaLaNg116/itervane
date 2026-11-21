import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { formalReleaseTargetSchema, ociDigestSchema, qualifiedImageArchiveSchema, releaseRegistryOriginSchema,
  type QualifiedImageArchive } from '@itervane/contracts';
import { sha256 } from '@itervane/runner';
import { z } from 'zod';

const manifestType = 'application/vnd.oci.image.manifest.v1+json';
const configType = 'application/vnd.oci.image.config.v1+json';
const metadataLimit = 64 * 1024;
const layoutProofSchema = z.strictObject({ manifestDigest: ociDigestSchema, configDigest: ociDigestSchema });
const frozenImageSchema = layoutProofSchema.extend({ archive: qualifiedImageArchiveSchema });
const registryTargetSchema = formalReleaseTargetSchema.pick({ imageRepository: true, registryOrigin: true }).required();
const manifestSchema = z.object({
  schemaVersion: z.literal(2), mediaType: z.literal(manifestType),
  config: z.object({ mediaType: z.literal(configType), digest: ociDigestSchema, size: z.int().min(1).max(metadataLimit) }),
});
const credentialsSchema = z.strictObject({
  username: z.string().min(1).max(255).regex(/^[^:\p{Cc}]+$/u),
  password: z.string().min(1).max(1024).regex(/^[^\p{Cc}]+$/u),
});
type RegistryConfiguration = { origin: string; credentials?: z.input<typeof credentialsSchema> };
type RegistryTools = Readonly<{ materializer: string; skopeo: string }>;
export type RegistryImageProof = Readonly<{
  registryOrigin: string; repository: string; reference: string;
  manifestDigest: string; configDigest: string; archive: QualifiedImageArchive;
}>;
const deadline = (milliseconds: number, signal?: AbortSignal) => {
  const limit = AbortSignal.timeout(milliseconds);
  return signal ? AbortSignal.any([limit, signal]) : limit;
};

async function runTool(file: string, args: string[], directory: string, limitMs: number, signal?: AbortSignal) {
  const active = deadline(limitMs, signal);
  active.throwIfAborted();
  const child = spawn(file, args, { cwd: directory, stdio: ['ignore', 'pipe', 'ignore'],
    env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', TMPDIR: directory,
      XDG_CONFIG_HOME: directory, XDG_CACHE_HOME: directory, XDG_RUNTIME_DIR: directory },
  });
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let length = 0;
    let failed = false;
    const stop = () => { child.kill('SIGKILL'); };
    child.on('error', () => { failed = true; });
    child.stdout.on('data', (chunk: Buffer) => {
      length += chunk.length;
      if (length <= 4096) chunks.push(chunk);
      else { failed = true; stop(); }
    });
    active.addEventListener('abort', stop, { once: true });
    if (active.aborted) stop();
    child.once('close', code => {
      active.removeEventListener('abort', stop);
      if (code === 0 && !failed && !active.aborted) resolve(Buffer.concat(chunks, length));
      else reject(new Error('registry_tool_failed'));
    });
  });
}

async function readMetadata(response: Response) {
  if (!response.body) throw new Error('registry_missing_body');
  const reader = response.body.getReader();
  try {
    const chunks: Uint8Array[] = [];
    let length = 0;
    while (true) {
      const part = await reader.read();
      if (part.done) return Buffer.concat(chunks, length);
      length += part.value.length;
      if (length > metadataLimit) throw new Error('registry_metadata_limit');
      chunks.push(part.value);
    }
  } finally { await reader.cancel().catch(() => undefined); }
}

export class ReleaseRegistryPublisher {
  private readonly origin: URL;
  private readonly registryHost: string;
  private readonly tools: RegistryTools;
  readonly #authorization?: string;

  constructor(config: RegistryConfiguration, tools: RegistryTools) {
    const origin = releaseRegistryOriginSchema.safeParse(config.origin);
    if (!origin.success) throw new Error('invalid_release_registry');
    const url = new URL(origin.data);
    const credentials = config.credentials && credentialsSchema.parse(config.credentials);
    if ((url.protocol !== 'https:' && credentials) || !isAbsolute(tools.materializer) || !isAbsolute(tools.skopeo)) {
      throw new Error('invalid_release_registry');
    }
    this.origin = url;
    this.tools = { ...tools };
    // A bare hostname in a Docker reference would otherwise be a repository namespace.
    this.registryHost = url.hostname === 'localhost' || url.hostname.includes('.') || url.hostname.includes(':') || url.port
      ? url.host : `${url.hostname}:443`;
    if (credentials) this.#authorization = Buffer.from(`${credentials.username}:${credentials.password}`).toString('base64');
  }

  async publish(rawTarget: z.input<typeof registryTargetSchema>, raw: z.input<typeof frozenImageSchema>, archivePath: string,
    authorize: () => Promise<void>, signal?: AbortSignal): Promise<RegistryImageProof> {
    const { imageRepository: repository, registryOrigin } = registryTargetSchema.parse(rawTarget);
    if (this.origin.origin !== registryOrigin) throw new Error('release_registry_drift');
    const image = frozenImageSchema.parse(raw);
    if (process.platform !== 'linux' || !process.getuid?.() || !isAbsolute(archivePath)) throw new Error('invalid_release_archive_path');
    signal?.throwIfAborted();
    await authorize();
    const directory = await mkdtemp(join(tmpdir(), 'itervane-registry-'));
    const layout = join(directory, 'layout');
    const reference = `${this.registryHost}/${repository}@${image.manifestDigest}`;
    try {
      if (layout.includes(':')) throw new Error('invalid_oci_layout_path');
      const evidence = layoutProofSchema.parse(JSON.parse((await runTool('/usr/bin/python3',
        ['-I', '-B', this.tools.materializer, archivePath, layout, image.archive.sha256, String(image.archive.bytes),
          image.manifestDigest, image.configDigest], directory, 30_000, signal)).toString('utf8')));
      if (evidence.manifestDigest !== image.manifestDigest || evidence.configDigest !== image.configDigest) throw new Error('registry_layout_binding');
      if (!await this.readBack(repository, image, true, signal)) {
        const auth = join(directory, 'auth.json');
        const policy = join(directory, 'policy.json');
        await writeFile(auth, JSON.stringify({ auths: this.#authorization
          ? { [this.registryHost]: { auth: this.#authorization } } : {} }), { flag: 'wx', mode: 0o600 });
        await writeFile(policy, JSON.stringify({ default: [{ type: 'reject' }], transports: {
          oci: { '': [{ type: 'insecureAcceptAnything' }] },
        } }), { flag: 'wx', mode: 0o600 });
        await authorize();
        signal?.throwIfAborted();
        // A lost copy response may follow a successful write. Always check the immutable reference.
        await runTool(this.tools.skopeo, ['--policy', policy, 'copy', '--quiet', '--preserve-digests', '--retry-times', '0',
          '--dest-authfile', auth, `--dest-tls-verify=${this.origin.protocol === 'https:'}`, `oci:${layout}`, `docker://${reference}`],
        directory, 120_000, signal).catch(() => undefined);
        signal?.throwIfAborted();
        await this.readBack(repository, image, false, signal);
      }
      await authorize();
      signal?.throwIfAborted();
      return { registryOrigin: this.origin.origin, repository, reference, ...image };
    } finally { await rm(directory, { recursive: true, force: true }); }
  }

  private async readBack(repository: string, image: z.output<typeof frozenImageSchema>, allowMissing: boolean, signal?: AbortSignal) {
    const read = async (kind: 'manifests' | 'blobs', digest: string) => {
      const response = await fetch(new URL(`/v2/${repository}/${kind}/${digest}`, this.origin), {
        headers: { ...(kind === 'manifests' ? { Accept: manifestType } : {}),
          ...(this.#authorization ? { Authorization: `Basic ${this.#authorization}` } : {}) },
        redirect: 'error', signal: deadline(8000, signal),
      });
      if (!response.ok) {
        await response.body?.cancel();
        if (allowMissing && kind === 'manifests' && response.status === 404) return null;
        throw new Error('registry_publication_unconfirmed');
      }
      if (response.headers.get('docker-content-digest') !== digest || (kind === 'manifests'
          && response.headers.get('content-type')?.split(';', 1)[0]?.trim() !== manifestType)) {
        await response.body?.cancel();
        throw new Error('registry_response_binding');
      }
      const bytes = await readMetadata(response);
      if (`sha256:${sha256(bytes)}` !== digest) throw new Error('registry_response_digest');
      return bytes;
    };
    const manifest = await read('manifests', image.manifestDigest);
    if (!manifest) return false;
    const parsed = manifestSchema.parse(JSON.parse(manifest.toString('utf8')));
    if (parsed.config.digest !== image.configDigest) throw new Error('registry_config_binding');
    const config = await read('blobs', image.configDigest);
    if (config?.length !== parsed.config.size) throw new Error('registry_config_binding');
    return true;
  }
}
