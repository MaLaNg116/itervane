import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { Annotation, Command, START, StateGraph, interrupt } from '@langchain/langgraph';
import { PostgresSaver } from '@langchain/langgraph-checkpoint-postgres';
import { eventReasonMessages, sourceInspectionObservationSchema, sourceInspectionPauseReasonSchema,
  type SourceInspectionPauseReason, type ToolResult } from '@itervane/contracts';
import { queueName, type Database } from '../persistence/database.js';
import { DomainError } from '../service/errors.js';
import { publishFormalRepair } from '../service/repair-result.js';
import { BudgetExhausted, ExecutionLost, type ExecutionScope } from './authority.js';
import { GuardedCheckpointer } from './checkpointer.js';
import { ExecutionCoordinator } from './coordinator.js';
import { runFormalAudit, type AuditModel } from './formal-audit.js';
import { runFormalRepair, type FormalRepairOptions } from './formal-repair.js';
import { ToolGateway } from './tools.js';
import type { InspectionRunner } from './source-inspection.js';

const State = Annotation.Root({
  registered: Annotation<boolean>({ reducer: (_a, b) => b, default: () => false }),
  inspectionReason: Annotation<SourceInspectionPauseReason>({ reducer: (_a, b) => b, default: () => 'runner_unavailable' }),
});

function inspectionReason(result: ToolResult): SourceInspectionPauseReason {
  if (result.status === 'success') {
    const observed = sourceInspectionObservationSchema.parse(result.data);
    return observed.coverage === 'complete' ? 'inspection_ready' : 'inspection_incomplete';
  }
  if (result.status === 'unknown') return 'inspection_reconciling';
  if (result.status === 'business_error' || result.status === 'infrastructure_error') {
    const reason = sourceInspectionPauseReasonSchema.safeParse(result.code);
    if (reason.success) return reason.data;
  }
  throw new DomainError('unavailable');
}

export class DurableWorker {
  readonly id = randomUUID();
  readonly coordinator: ExecutionCoordinator;
  readonly gateway: ToolGateway;
  private readonly saver: PostgresSaver;
  private readonly auditModel: AuditModel | undefined;
  private readonly repair: FormalRepairOptions | undefined;
  private active: Promise<boolean> | undefined;
  private abort: AbortController | undefined;
  private closing = false;
  private closePromise: Promise<void> | undefined;

  constructor(readonly database: Database, connectionString: string,
    options: { leaseSeconds?: number; runner?: InspectionRunner; auditModel?: AuditModel; repair?: FormalRepairOptions } = {}) {
    this.coordinator = new ExecutionCoordinator(database, options);
    this.gateway = new ToolGateway(this.coordinator, options.runner);
    this.auditModel = options.auditModel;
    this.repair = options.repair;
    const pool = new pg.Pool({ connectionString, max: 2, connectionTimeoutMillis: 3_000, statement_timeout: 5_000, idle_in_transaction_session_timeout: 5_000 });
    pool.on('error', () => console.error(JSON.stringify({ level: 'error', code: 'infrastructure_error', component: 'checkpointer' })));
    this.saver = new PostgresSaver(pool, undefined, { schema: 'itervane_checkpoint' });
  }

  tick(): Promise<boolean> {
    if (this.closing) return Promise.resolve(false);
    // 防止同进程重复 tick；跨进程互斥由全局 slot 负责。
    this.active ??= this.performTick().finally(() => { this.active = undefined; });
    return this.active;
  }

  private async performTick(): Promise<boolean> {
    await this.coordinator.reconcile(this.id);
    if (this.closing) return false;
    const [job] = await this.database.boss.fetch(queueName);
    if (!job) return false;
    const scope = await this.coordinator.claim(job, this.id);
    if (scope && !this.closing) await this.execute(scope);
    return true;
  }

  private async execute(scope: ExecutionScope) {
    const controller = new AbortController(); this.abort = controller;
    let heartbeat: Promise<void> | undefined;
    const timer = setInterval(() => {
      if (heartbeat || controller.signal.aborted) return;
      heartbeat = this.coordinator.heartbeat(scope).then(alive => { if (!alive) controller.abort(new ExecutionLost()); }, error => controller.abort(error))
        .finally(() => { heartbeat = undefined; });
    }, this.coordinator.leaseSeconds * 1_000 / 3);
    timer.unref();
    let phase: 'preflight' | 'audit' | 'repair' = 'preflight';
    try {
      const runtime = await this.coordinator.withLease(scope, async (_tx, current) => current.runtime);
      if (runtime.reason === 'repair_pending') {
        phase = 'repair';
        await this.executeRepair(scope, controller.signal);
        return;
      }
      const saver = new GuardedCheckpointer(this.coordinator, scope, this.saver);
      const graph = new StateGraph(State)
        .addNode('describe', async () => {
          controller.signal.throwIfAborted();
          const result = await this.gateway.call(scope, 'project.describe', {}, 'project:registration');
          if (result.status !== 'success') throw new DomainError('unavailable');
          return { registered: true };
        })
        .addNode('inspect', async () => {
          controller.signal.throwIfAborted();
          const result = await this.gateway.call(scope, 'source.inspect', {}, `source:${runtime.resumeCount}`, controller.signal);
          return { inspectionReason: inspectionReason(result) };
        })
        .addNode('wait', state => {
          const reason = state.inspectionReason ?? 'runner_unavailable';
          interrupt({ reason, messageKey: eventReasonMessages[reason] });
          return {};
        })
        .addEdge(START, 'describe').addEdge('describe', 'inspect').addEdge('inspect', 'wait').addEdge('wait', 'inspect')
        .compile({ checkpointer: saver });
      // Each work node observes cancellation. Racing graph.invoke against the signal would release the slot before Runner teardown settles.
      const config = { configurable: { thread_id: saver.threadId }, recursionLimit: 12 };
      const snapshot = runtime.checkpointId ? await graph.getState(config) : undefined;
      const interrupted = snapshot?.tasks.some(task => task.interrupts?.length);
      let result = snapshot;
      if (!interrupted || snapshot?.values.inspectionReason !== 'inspection_ready') {
        const input = !runtime.checkpointId ? {} : runtime.resumePending && interrupted ? new Command({ resume: 'retry_preflight' }) : null;
        await graph.invoke(input, config);
        result = await graph.getState(config);
      }
      controller.signal.throwIfAborted();
      if (!result?.tasks.some(task => task.interrupts?.length)) throw new DomainError('unavailable');
      const reason = sourceInspectionPauseReasonSchema.parse(result.values.inspectionReason ?? 'runner_unavailable');
      if (reason === 'inspection_ready') {
        phase = 'audit';
        const next = await runFormalAudit(this.coordinator, scope, this.saver, this.auditModel, controller.signal, this.repair !== undefined);
        if (next === 'repair_pending') {
          phase = 'repair';
          await this.executeRepair(scope, controller.signal);
        }
        if (next !== 'unavailable') return;
      }
      await this.coordinator.pause(scope, reason);
    } catch (error) {
      if (!this.closing) {
        const reason = error instanceof BudgetExhausted ? 'budget_exhausted'
          : error instanceof DomainError && ['forbidden', 'not_found'].includes(error.code) ? 'permission_revoked'
          : error instanceof ExecutionLost ? 'cancelled' : controller.signal.aborted ? 'cancelled_or_interrupted'
          : phase === 'repair' ? 'repair_failed' : phase === 'audit' ? 'audit_failed' : 'execution_error';
        try { await this.coordinator.stop(scope, reason, error instanceof ExecutionLost); }
        catch (stopError) { if (!(stopError instanceof ExecutionLost)) throw stopError; }
      }
    } finally {
      clearInterval(timer); await heartbeat; this.abort = undefined;
    }
  }

  private async executeRepair(scope: ExecutionScope, signal: AbortSignal) {
    const model = this.auditModel;
    if (!model || !this.repair) {
      await this.coordinator.pause(scope, 'repair_deferred');
      return;
    }
    const report = await runFormalRepair(this.coordinator, scope, this.saver, model, this.repair, signal);
    await this.coordinator.withLease(scope, (tx, { task }) => publishFormalRepair(tx, task, scope, report, model.adapter.protocol, signal));
  }

  close(): Promise<void> {
    this.closing = true; this.abort?.abort();
    this.closePromise ??= (async () => { try { await this.active; } finally { await this.saver.end(); } })();
    return this.closePromise;
  }
}
