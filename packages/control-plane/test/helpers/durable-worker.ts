import { openDatabase } from '../../src/persistence/database.js';
import { DurableWorker } from '../../src/runtime/worker.js';

// Test-only fault injection: kill the real worker after saver publication but before pause commits.
const database = await openDatabase(process.env.DATABASE_URL!);
const worker = new DurableWorker(database, process.env.DATABASE_URL!);
worker.coordinator.pause = async scope => {
  const runtime = await worker.coordinator.withLease(scope, async (_tx, current) => current.runtime);
  process.send?.({ taskId: scope.taskId, checkpointId: runtime.checkpointId });
  await new Promise<void>(() => {});
};
try { await worker.tick(); }
catch { process.exitCode = 1; }
