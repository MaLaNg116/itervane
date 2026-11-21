import { setTimeout } from 'node:timers/promises';
import { QualifiedInspectionClient } from '@itervane/runner';
import { workerConfig } from '../config.js';
import { openDatabase } from '../persistence/database.js';
import { DurableWorker } from '../runtime/worker.js';
import { configuredAuditModel } from '../runtime/formal-audit.js';

try {
  const config = workerConfig();
  const runner = config.runner ? new QualifiedInspectionClient(config.runner) : undefined;
  const auditModel = config.auditModel ? configuredAuditModel(config.auditModel) : undefined;
  const database = await openDatabase(config.databaseUrl);
  const worker = new DurableWorker(database, config.databaseUrl, { leaseSeconds: config.leaseSeconds,
    ...(runner ? { runner } : {}), ...(auditModel ? { auditModel } : {}),
    ...(runner && config.repairProtectedPaths ? { repair: { runner, protectedPaths: config.repairProtectedPaths,
      npmApprovals: config.npmRepairApprovals,
    } } : {}),
  });
  const controller = new AbortController();
  const stop = () => { controller.abort(); void worker.close().catch(() => undefined); };
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, stop);
  try {
    while (!controller.signal.aborted) {
      try { await worker.tick(); }
      catch { console.error(JSON.stringify({ level: 'error', code: 'worker_tick_failed' })); }
      if (!controller.signal.aborted) await setTimeout(config.pollMs, undefined, { signal: controller.signal }).catch(() => {});
    }
  } finally {
    for (const signal of ['SIGINT', 'SIGTERM']) process.removeListener(signal, stop);
    // 关闭期间不把进程终止伪装成用户取消；新 Worker 会按租约和检查点重领。
    try { await worker.close(); } finally { await database.close(); }
  }
} catch {
  console.error('Worker startup failed. Verify database migrations, Runner settings, and model settings.');
  process.exitCode = 1;
}
