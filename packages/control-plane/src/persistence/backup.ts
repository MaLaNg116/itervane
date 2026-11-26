import { createHash } from 'node:crypto';
import { constants, createWriteStream } from 'node:fs';
import { lstat, mkdir, open, readFile, readdir, unlink, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { sha256Schema } from '@itervane/contracts';
import { z } from 'zod';
import { backupContentsSchema, type BackupPostgres } from './backup-postgres.js';

const manifestName = 'manifest.json';
const databaseDump = 'database.dump';
const archivesFolder = 'artifacts';
const configFolder = 'configuration';
const validName = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const stampSchema = z.strictObject({ sha256: sha256Schema, bytes: z.int().nonnegative() });
const configStampSchema = z.strictObject({ ...stampSchema.shape,
  path: z.string().refine(path => path.split('/').every(name => validName.test(name))),
});
const manifestSchema = z.strictObject({
  version: z.literal(1), postgresMajor: z.literal(17), database: stampSchema,
  contents: backupContentsSchema, configuration: configStampSchema.array(),
}).refine(value => new Set(value.configuration.map(item => item.path)).size === value.configuration.length
  && new Set(value.contents.archives.map(item => item.sha256)).size === value.contents.archives.length);

type Stamp = z.infer<typeof stampSchema>;
type BackupManifest = z.infer<typeof manifestSchema>;

async function requireDirectory(path: string) {
  if (!(await lstat(path)).isDirectory()) throw new Error('backup_directory_invalid');
}

async function configFiles(root: string, parts: string[] = []): Promise<string[]> {
  const directory = join(root, ...parts);
  await requireDirectory(directory);
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries.sort((left, right) => left.name < right.name ? -1 : left.name === right.name ? 0 : 1)) {
    if (!validName.test(entry.name)) throw new Error('backup_configuration_name_invalid');
    const path = [...parts, entry.name];
    if (entry.isDirectory()) files.push(...await configFiles(root, path));
    else if (entry.isFile()) files.push(path.join('/'));
    else throw new Error('backup_configuration_file_invalid');
  }
  return files;
}

async function fileStamp(source: string, destination?: string): Promise<Stamp> {
  const expected = await lstat(source);
  if (!expected.isFile() || expected.nlink !== 1) throw new Error('backup_file_invalid');
  const file = await open(source, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const before = await file.stat();
    if (before.dev !== expected.dev || before.ino !== expected.ino || before.nlink !== 1) throw new Error('backup_file_changed');
    const hash = createHash('sha256');
    let bytes = 0;
    const input = file.createReadStream({ autoClose: false });
    async function* measured() {
      for await (const chunk of input) {
        hash.update(chunk);
        bytes += chunk.length;
        yield chunk;
      }
    }
    if (destination) await pipeline(measured(), createWriteStream(destination, { flags: 'wx', mode: 0o400 }));
    else for await (const _ of measured()) { /* Consume the entire file. */ }
    const after = await file.stat();
    if (before.size !== bytes || after.size !== bytes || before.mtimeMs !== after.mtimeMs) throw new Error('backup_file_changed');
    return { sha256: hash.digest('hex'), bytes };
  } finally { await file.close(); }
}

async function copyVerified(source: string, destination: string, stamp: Stamp) {
  const actual = await fileStamp(source, destination);
  if (actual.bytes !== stamp.bytes || actual.sha256 !== stamp.sha256) throw new Error('backup_file_integrity');
}

function archivePath(directory: string, digest: string) {
  return join(directory, digest + '.oci.tar');
}

function checkInventory(before: BackupManifest['contents'], after: BackupManifest['contents']) {
  if (JSON.stringify(before) !== JSON.stringify(after)) throw new Error('backup_database_inventory_changed');
}

async function outputFolders(root: string) {
  await mkdir(root, { mode: 0o700 });
  const artifacts = join(root, archivesFolder);
  const configuration = join(root, configFolder);
  await mkdir(artifacts, { mode: 0o700 });
  await mkdir(configuration, { mode: 0o700 });
  return { artifacts, configuration };
}

export async function exportBackup(postgres: BackupPostgres, destination: string, archiveSource: string, configSource: string) {
  const root = resolve(destination);
  await requireDirectory(archiveSource);
  const selectedConfig = await configFiles(configSource);
  const contents = await postgres.inventory();
  const output = await outputFolders(root);
  const dump = join(root, databaseDump);
  await postgres.dump(dump);
  const configuration: BackupManifest['configuration'] = [];
  for (const archive of contents.archives) {
    await copyVerified(archivePath(archiveSource, archive.sha256), archivePath(output.artifacts, archive.sha256), archive);
  }
  for (const path of selectedConfig) {
    const target = join(output.configuration, path);
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    configuration.push({ path, ...await fileStamp(join(configSource, path), target) });
  }
  checkInventory(contents, await postgres.inventory());
  const manifest = manifestSchema.parse({ version: 1, postgresMajor: 17, database: await fileStamp(dump), contents, configuration });
  await writeFile(join(root, manifestName), JSON.stringify(manifest) + '\n', { flag: 'wx', mode: 0o400 });
  return { tables: contents.tables.length, archives: contents.archives.length, configFiles: configuration.length };
}

export async function restoreBackup(postgres: BackupPostgres, bundle: string, destination: string) {
  const root = resolve(bundle);
  await requireDirectory(root);
  const manifestPath = join(root, manifestName);
  if (!(await lstat(manifestPath)).isFile()) throw new Error('backup_manifest_invalid');
  const manifestData = await readFile(manifestPath);
  const manifest = manifestSchema.parse(JSON.parse(manifestData.toString('utf8')));
  const manifestSha256 = createHash('sha256').update(manifestData).digest('hex');
  await postgres.requireEmptyTarget();
  const bundleArtifacts = join(root, archivesFolder);
  const bundleConfig = join(root, configFolder);
  await requireDirectory(bundleArtifacts);
  if (JSON.stringify(await configFiles(bundleConfig)) !== JSON.stringify(manifest.configuration.map(item => item.path))) {
    throw new Error('backup_configuration_integrity');
  }

  const outputRoot = resolve(destination);
  const output = await outputFolders(outputRoot);
  const stagedDump = join(outputRoot, databaseDump);
  try {
    for (const archive of manifest.contents.archives) {
      await copyVerified(archivePath(bundleArtifacts, archive.sha256), archivePath(output.artifacts, archive.sha256), archive);
    }
    for (const file of manifest.configuration) {
      const target = join(output.configuration, file.path);
      await mkdir(dirname(target), { recursive: true, mode: 0o700 });
      await copyVerified(join(bundleConfig, file.path), target, file);
    }
    await copyVerified(join(root, databaseDump), stagedDump, manifest.database);
    await postgres.requireEmptyTarget();
    await postgres.restore(stagedDump);
    checkInventory(manifest.contents, await postgres.inventory());
  } finally {
    await unlink(stagedDump).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error; });
  }
  const result = { version: 1, manifestSha256, tables: manifest.contents.tables.length, archives: manifest.contents.archives.length,
    configFiles: manifest.configuration.length, reconciled: false };
  await writeFile(join(outputRoot, 'restore-receipt.json'), JSON.stringify(result) + '\n', { flag: 'wx', mode: 0o400 });
  return result;
}
