import { z } from 'zod';
import { runtimeConfig } from '../config.js';
import { openDatabase } from '../persistence/database.js';
import { bootstrapOwner } from '../service/resources.js';

try {
  const config = runtimeConfig();
  const subject = z.string().min(1).max(255).parse(process.env.ITERVANE_OWNER_SUBJECT);
  const database = await openDatabase(config.databaseUrl);
  try {
    const owner = await bootstrapOwner(database, { issuer: config.issuer, subject });
    console.log(JSON.stringify({ event: 'owner-initialized', ...owner }));
  } finally { await database.close(); }
} catch { console.error('Owner bootstrap failed; existing ownership is never replaced automatically. Credentials are omitted.'); process.exitCode = 1; }
