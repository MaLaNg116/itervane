import { spawn, type ChildProcessByStdio } from 'node:child_process';
import { createReadStream, createWriteStream } from 'node:fs';
import type { Readable, Writable } from 'node:stream';
import { text } from 'node:stream/consumers';
import { pipeline } from 'node:stream/promises';
import { qualifiedImageArchiveSchema } from '@itervane/contracts';
import { z } from 'zod';

const schemas = ['itervane', 'itervane_checkpoint', 'itervane_migrations', 'itervane_queue'];
const schemaList = schemas.map(schema => `'${schema}'`).join(', ');
const inspectDatabase = `
  SET search_path = pg_catalog;
  SELECT jsonb_build_object('serverMajor', current_setting('server_version_num')::int / 10000,
    'quiescent', NOT EXISTS (SELECT 1 FROM pg_stat_activity
      WHERE datname = current_database() AND coalesce(backend_type, 'client backend') = 'client backend' AND pid <> pg_backend_pid()),
    'schemas', ARRAY(SELECT nspname FROM pg_namespace WHERE nspname IN (${schemaList}) ORDER BY nspname),
    'empty', NOT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname NOT IN ('public', 'pg_catalog', 'information_schema')
      AND nspname NOT LIKE 'pg\\_%')
      AND NOT EXISTS (SELECT 1 FROM pg_class WHERE relnamespace = 'public'::regnamespace)
  );
`;

const inspectContents = `
  BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;
  SET LOCAL timezone = 'UTC';
  SET LOCAL datestyle = 'ISO, YMD';
  SET LOCAL intervalstyle = 'postgres';
  SET LOCAL bytea_output = 'hex';
  ${inspectDatabase}
  SELECT format($statement$
    SELECT jsonb_build_object('table', %L, 'rows', count(*)::text,
      'checksum', coalesce(sum(hashtextextended(to_jsonb(entry)::text, 0)::numeric), 0)::text)
    FROM %I.%I AS entry
  $statement$, namespace.nspname || '.' || relation.relname, namespace.nspname, relation.relname)
  FROM pg_class relation JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
  WHERE namespace.nspname IN (${schemaList}) AND relation.relkind IN ('r', 'p') AND NOT relation.relispartition
  ORDER BY namespace.nspname COLLATE "C", relation.relname COLLATE "C"
  \\gexec
  SELECT jsonb_build_object('archives', coalesce(jsonb_agg(archive ORDER BY archive->>'sha256'), '[]'::jsonb))
  FROM (
    SELECT document#>'{archiveVerification,archive}' AS archive FROM itervane.formal_verification_results
    UNION
    SELECT receipt#>'{snapshot,build,baseline,image,archive}' FROM itervane.formal_rescan_attempts
    UNION
    SELECT document#>'{image,archive}' FROM itervane.release_candidates WHERE document->>'origin' = 'formal_verification'
  ) reference WHERE archive IS NOT NULL;
  COMMIT;
`;

const databaseSchema = z.strictObject({
  serverMajor: z.literal(17), quiescent: z.boolean(), schemas: z.string().array(), empty: z.boolean(),
});
const tableSchema = z.strictObject({ table: z.string().min(1), rows: z.string().regex(/^\d+$/), checksum: z.string().regex(/^-?\d+$/) });
const archiveSchema = z.strictObject({ archives: qualifiedImageArchiveSchema.array() });
export const backupContentsSchema = z.strictObject({ tables: tableSchema.array().min(1), archives: archiveSchema.shape.archives });

export type PostgresTool = 'psql' | 'pg_dump' | 'pg_restore';
export type StartPostgresTool = (tool: PostgresTool, args: string[]) => ChildProcessByStdio<Writable, Readable, null>;

export function postgresBackupClient(database: string, start: StartPostgresTool) {
  if (!/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,62}$/.test(database)) throw new Error('backup_database_name_required');
  const input = `--dbname=${database}`;

  async function requireClient17(tool: PostgresTool) {
    const child = start(tool, ['--version']);
    child.stdin.end();
    const result = text(child.stdout);
    await finish(child, tool, async () => { await result; });
    if (!(await result).includes('(PostgreSQL) 17.')) throw new Error('backup_postgres_client_version');
  }

  async function query(sql: string): Promise<unknown[]> {
    const child = start('psql', [input, '--no-password', '--no-psqlrc', '--quiet', '--no-align', '--tuples-only',
      '--set=ON_ERROR_STOP=1', '--file=-']);
    const result = text(child.stdout);
    await finish(child, 'psql', async () => { await Promise.all([pipeline([Buffer.from(sql)], child.stdin), result]); });
    return (await result).trim().split(/\r?\n/).map(line => JSON.parse(line) as unknown);
  }

  function requireQuiescent(value: unknown) {
    const state = databaseSchema.parse(value);
    if (!state.quiescent) throw new Error('backup_database_in_use');
    return state;
  }

  return {
    async inventory() {
      const [first] = await query(inspectDatabase);
      if (requireQuiescent(first).schemas.join(',') !== schemas.join(',')) throw new Error('backup_database_schema');
      const [state, ...contents] = await query(inspectContents);
      requireQuiescent(state);
      return backupContentsSchema.parse({ tables: contents.slice(0, -1), ...archiveSchema.parse(contents.at(-1)) });
    },
    async requireEmptyTarget() {
      const [first] = await query(inspectDatabase);
      if (!requireQuiescent(first).empty) throw new Error('restore_target_not_empty');
    },
    async dump(destination: string) {
      await requireClient17('pg_dump');
      const child = start('pg_dump', [input, '--no-password', '--format=custom', '--no-owner', '--no-acl', '--strict-names',
        ...schemas.map(schema => `--schema=${schema}`)]);
      child.stdin.end();
      await finish(child, 'pg_dump', () => pipeline(child.stdout, createWriteStream(destination, { flags: 'wx', mode: 0o600 })));
    },
    async restore(source: string) {
      await requireClient17('pg_restore');
      const child = start('pg_restore', [input, '--no-password', '--single-transaction', '--no-owner', '--no-acl', '--no-tablespaces']);
      child.stdout.resume();
      await finish(child, 'pg_restore', () => pipeline(createReadStream(source), child.stdin));
    },
  };
}

async function finish(child: ReturnType<StartPostgresTool>, tool: PostgresTool, transfer: () => Promise<void>) {
  // Native client stderr can contain SQL data or connection information.
  const done = new Promise<void>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', code => code === 0 ? resolve() : reject(new Error('postgres_client_failed')));
  });
  try {
    await Promise.all([done, transfer()]);
  } catch {
    child.kill();
    await done.catch(() => {});
    throw new Error(`backup_${tool}_failed`);
  }
}

export type BackupPostgres = ReturnType<typeof postgresBackupClient>;

export function localBackupPostgres(env: NodeJS.ProcessEnv = process.env): BackupPostgres {
  if (!env.PGHOST || !env.PGUSER) throw new Error('backup_database_configuration_required');
  return postgresBackupClient(env.PGDATABASE ?? '', (tool, args) => spawn(tool, args, {
    env: { ...env, PGCONNECT_TIMEOUT: env.PGCONNECT_TIMEOUT ?? '5', PGCLIENTENCODING: 'UTF8' },
    stdio: ['pipe', 'pipe', 'ignore'],
  }));
}
