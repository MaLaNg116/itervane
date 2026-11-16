import { PgBoss } from 'pg-boss';

// Trusted P0 test process. The parent kills it after claim; no graceful stop,
// completion, or infrastructure mutation can disguise the recovery window.
const schema = process.env.ITERVANE_QUEUE_SCHEMA;
if (!/^itervane_queue_[a-f0-9]{12}$/.test(schema ?? '')) process.exit(2);
const boss = new PgBoss({ connectionString: process.env.DATABASE_URL, schema, supervise: false, schedule: false, migrate: false });
await boss.start();
const [job] = await boss.fetch('crash-recovery');
process.send?.({ jobId: job?.id });
setInterval(() => {}, 1_000);
