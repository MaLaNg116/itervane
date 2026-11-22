import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { Annotation, Command, START, StateGraph, interrupt } from '@langchain/langgraph';
import { PostgresSaver } from '@langchain/langgraph-checkpoint-postgres';
import { eventReasonMessages, sourceInspectionObservationSchema, sourceInspectionPauseReasonSchema,
  type SourceInspectionPauseReason, type StandardVerificationProfile, type ToolResult } from '@itervane/contracts';
import { queueName, type Database } from '../persistence/database.js';
import type { runRuntime } from '../persistence/schema.js';
import { DomainError } from '../service/errors.js';
import { publishFormalRepair } from '../service/repair-result.js';
import { readRepairRetry, verificationProfileFingerprint } from '../service/repair-retry.js';
import { publishFormalVerification } from '../service/verification-result.js';
import { BudgetExhausted, ExecutionLost, type ExecutionScope } from './authority.js';
import { GuardedCheckpointer } from './checkpointer.js';
import { ExecutionCoordinator } from './coordinator.js';
import { runFormalAudit, type AuditModel } from './formal-audit.js';
import { runFormalRepair, type FormalRepairOptions } from './formal-repair.js';
import { runFormalVerification, type FormalVerificationOptions } from './formal-verification.js';
import { repairPolicyFingerprint } from './repair-execution.js';
import { ToolGateway } from './tools.js';
import type { InspectionRunner } from './source-inspection.js';
import { prepareFormalVerificationInput } from './verification-input.js';

type VerificationOptions = FormalVerificationOptions & { profile: StandardVerificationProfile };
type PreflightRuntime = Pick<typeof runRuntime.$inferSelect, 'checkpointId' | 'resumeCount' | 'resumePending'>;

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
  private readonly verification: VerificationOptions | undefined;
  private active: Promise<boolean> | undefined;
  private abort: AbortController | undefined;
  private closing = false;
  private closePromise: Promise<void> | undefined;

  constructor(readonly database: Database, connectionString: string,
    options: { leaseSeconds?: number; runner?: InspectionRunner; auditModel?: AuditModel;
      repair?: FormalRepairOptions; verification?: VerificationOptions } = {}) {
    this.coordinator = new ExecutionCoordinator(database, options);
    this.gateway = new ToolGateway(this.coordinator, options.runner);
    this.auditModel = options.auditModel;
    this.repair = options.repair;
    this.verification = options.verification;
    if (this.verification && (!options.runner || !options.auditModel)) throw new Error('Incomplete verification Worker');
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
    let phase: 'preflight' | 'audit' | 'repair' | 'verification' = 'preflight';
    try {
      const { runtime, retry, role } = await this.coordinator.withLease(scope, async (tx, current) => ({
        runtime: current.runtime, retry: await readRepairRetry(tx, current.task, scope), role: current.run.role,
      }));
      if (role === 'operations') return await this.coordinator.stop(scope, 'operations_unavailable');
      if (retry && (!this.repair || !this.verification || retry.repairPolicySha256 !== repairPolicyFingerprint(this.repair)
          || retry.verificationProfileSha256 !== verificationProfileFingerprint(this.verification.profile))) {
        return await this.coordinator.stop(scope, 'repair_retry_configuration_changed');
      }
      let next: Awaited<ReturnType<typeof runFormalAudit>> | 'preflight' =
        runtime.reason === 'repair_pending' || runtime.reason === 'verification_pending' ? runtime.reason : 'preflight';
      if (next === 'preflight') {
        const reason = await this.inspect(scope, runtime, controller.signal);
        if (reason !== 'inspection_ready') return await this.coordinator.pause(scope, reason);
        phase = 'audit';
        next = await runFormalAudit(this.coordinator, scope, this.saver, this.auditModel, controller.signal,
          this.repair !== undefined, this.verification?.profile);
        if (next === 'unavailable') return await this.coordinator.pause(scope, reason);
      }
      if (next === 'repair_pending') {
        phase = 'repair';
        next = await this.executeRepair(scope, controller.signal);
      }
      if (next === 'verification_pending') {
        phase = 'verification';
        await this.executeVerification(scope, controller.signal);
      }
    } catch (error) {
      if (!this.closing) {
        const reason = error instanceof BudgetExhausted ? 'budget_exhausted'
          : error instanceof DomainError && ['forbidden', 'not_found'].includes(error.code) ? 'permission_revoked'
          : error instanceof ExecutionLost ? 'cancelled' : controller.signal.aborted ? 'cancelled_or_interrupted'
          : phase === 'verification' ? 'verification_unavailable'
          : phase === 'repair' ? 'repair_failed' : phase === 'audit' ? 'audit_failed' : 'execution_error';
        try { await this.coordinator.stop(scope, reason, error instanceof ExecutionLost); }
        catch (stopError) { if (!(stopError instanceof ExecutionLost)) throw stopError; }
      }
    } finally {
      clearInterval(timer); await heartbeat; this.abort = undefined;
    }
  }

  private async inspect(scope: ExecutionScope, runtime: PreflightRuntime, signal: AbortSignal) {
    const saver = new GuardedCheckpointer(this.coordinator, scope, this.saver);
    const graph = new StateGraph(State)
      .addNode('describe', async () => {
        signal.throwIfAborted();
        const result = await this.gateway.call(scope, 'project.describe', {}, 'project:registration');
        if (result.status !== 'success') throw new DomainError('unavailable');
        return { registered: true };
      })
      .addNode('inspect', async () => {
        signal.throwIfAborted();
        const result = await this.gateway.call(scope, 'source.inspect', {}, `source:${runtime.resumeCount}`, signal);
        return { inspectionReason: inspectionReason(result) };
      })
      .addNode('wait', state => {
        const reason = state.inspectionReason ?? 'runner_unavailable';
        interrupt({ reason, messageKey: eventReasonMessages[reason] });
        return {};
      })
      .addEdge(START, 'describe').addEdge('describe', 'inspect').addEdge('inspect', 'wait').addEdge('wait', 'inspect')
      .compile({ checkpointer: saver });
    // Keep the lease until the Runner has finished with the inspection.
    const config = { configurable: { thread_id: saver.threadId }, recursionLimit: 12 };
    const snapshot = runtime.checkpointId ? await graph.getState(config) : undefined;
    const interrupted = snapshot?.tasks.some(task => task.interrupts?.length);
    let result = snapshot;
    if (!interrupted || snapshot?.values.inspectionReason !== 'inspection_ready') {
      const input = !runtime.checkpointId ? {} : runtime.resumePending && interrupted ? new Command({ resume: 'retry_preflight' }) : null;
      await graph.invoke(input, config);
      result = await graph.getState(config);
    }
    signal.throwIfAborted();
    if (!result?.tasks.some(task => task.interrupts?.length)) throw new DomainError('unavailable');
    return sourceInspectionPauseReasonSchema.parse(result.values.inspectionReason ?? 'runner_unavailable');
  }

  private async executeRepair(scope: ExecutionScope, signal: AbortSignal) {
    const model = this.auditModel;
    if (!model || !this.repair) {
      await this.coordinator.pause(scope, 'repair_deferred');
      return 'settled';
    }
    const report = await runFormalRepair(this.coordinator, scope, this.saver, model, this.repair, signal);
    return this.coordinator.withLease(scope, async (tx, { task }) => {
      const profile = this.verification?.profile;
      const { next } = await publishFormalRepair(tx, task, scope, report, model.adapter.protocol, signal, Boolean(profile));
      if (next === 'verification_pending' && profile) await prepareFormalVerificationInput(tx, task, scope, profile);
      signal.throwIfAborted();
      return next;
    });
  }

  private async executeVerification(scope: ExecutionScope, signal: AbortSignal) {
    const model = this.auditModel;
    if (!model || !this.verification) return this.coordinator.stop(scope, 'verification_unavailable');
    const result = await runFormalVerification(this.coordinator, scope, this.saver, model, this.verification, signal);
    if (result.kind === 'rejected') return this.coordinator.stop(scope,
      result.cleanup === 'unknown' ? 'verification_reconciling' : 'verification_unavailable');
    const image = result.evidence.image;
    const archiveVerification = result.report.formalVerification?.outcome === 'observed' && image.status === 'scanned' && image.archive
      ? await this.verification.runner.verifyArchive?.(image.archive, signal) : undefined;
    const retry = this.repair ? { database: this.database, repairPolicySha256: repairPolicyFingerprint(this.repair) } : undefined;
    const published = archiveVerification ? { ...result, archiveVerification } : result;
    await this.coordinator.withLease(scope, (tx, { task }) => publishFormalVerification(tx, task, scope, published, model.adapter.protocol, signal, retry));
  }

  close(): Promise<void> {
    this.closing = true; this.abort?.abort();
    this.closePromise ??= (async () => { try { await this.active; } finally { await this.saver.end(); } })();
    return this.closePromise;
  }
}
