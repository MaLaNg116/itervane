import { open } from 'node:fs/promises';
import { runtimeConfig } from '../config.js';
import { openDatabase } from '../persistence/database.js';
import { registerReleaseTarget } from '../service/release-targets.js';

try {
  const [path, ...extra] = process.argv.slice(2);
  if (!path || extra.length) throw new Error('release_target_config_path');
  const file = await open(path, 'r');
  let document: unknown;
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size > 4096) throw new Error('release_target_config_file');
    const data = Buffer.alloc(4097);
    const { bytesRead } = await file.read(data, 0, data.length, 0);
    if (bytesRead !== info.size) throw new Error('release_target_config_size');
    document = JSON.parse(data.toString('utf8', 0, bytesRead));
  } finally { await file.close(); }
  const database = await openDatabase(runtimeConfig().databaseUrl);
  try { console.log(JSON.stringify(await registerReleaseTarget(database, document))); }
  finally { await database.close(); }
} catch {
  console.error('Release target registration failed. Check the protected environment, target settings and database access.');
  process.exitCode = 1;
}
