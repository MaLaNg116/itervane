import { runPostgresTests } from '../packages/verification/src/test-postgres.js';

process.exitCode = await runPostgresTests();
