import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { Annotation, Command, START, StateGraph, interrupt } from '@langchain/langgraph';
import { PostgresSaver } from '@langchain/langgraph-checkpoint-postgres';
import { queueName, type Database } from '../persistence/database.js';
import { DomainError } from '../service/errors.js';
import { BudgetExhausted, ExecutionLost, type ExecutionScope } from './authority.js';
import { GuardedCheckpointer } from './checkpointer.js';
import { ExecutionCoordinator } from './coordinator.js';
import { ToolGateway } from './tools.js';

const State = Annotation.Root({ registered: Annotation<boolean>({ reducer: (_a, b) => b, default: () => false }) });

export class DurableWorker {
  readonly id = randomUUID();
  readonly coordinator: ExecutionCoordinator;
  readonly gateway: ToolGateway;
  private readonly saver: PostgresSaver;
  private active: Promise<boolean> | undefined;
  private abort: AbortController | undefined;
  private closing = false;
  private closePromise: Promise<void> | undefined;

  constructor(readonly database: Database, connectionString: string, options: { leaseSeconds?: number } = {}) {
    this.coordinator = new ExecutionCoordinator(database, options);
    this.gateway = new ToolGateway(this.coordinator);
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
      heartbeat = this.coordinator.heartbeat(scope).then(alive => { if (!alive) controller.abort(); }, () => controller.abort())
        .finally(() => { heartbeat = undefined; });
    }, this.coordinator.leaseSeconds * 1_000 / 3);
    timer.unref();
    try {
      const runtime = await this.coordinator.withLease(scope, async (_tx, current) => current.runtime);
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
          const result = await this.gateway.call(scope, 'source.inspect', {}, `source:${runtime.resumeCount}`);
          if (result.status !== 'business_error' || result.code !== 'runner_unavailable') throw new DomainError('unavailable');
          return {};
        })
        .addNode('wait', () => { interrupt({ reason: 'runner_unavailable', messageKey: 'tool.runner_unavailable' }); return {}; })
        .addEdge(START, 'describe').addEdge('describe', 'inspect').addEdge('inspect', 'wait').addEdge('wait', 'inspect')
        .compile({ checkpointer: saver });
      const config = { configurable: { thread_id: scope.runId }, signal: controller.signal, recursionLimit: 12 };
      const snapshot = runtime.checkpointId ? await graph.getState(config) : undefined;
      const interrupted = snapshot?.tasks.some(task => task.interrupts?.length);
      const input = !runtime.checkpointId ? {} : runtime.resumePending && interrupted ? new Command({ resume: 'retry_preflight' }) : null;
      await graph.invoke(input, config);
      controller.signal.throwIfAborted();
      const result = await graph.getState(config);
      if (!result.tasks.some(task => task.interrupts?.length)) throw new DomainError('unavailable');
      await this.coordinator.pause(scope);
    } catch (error) {
      if (!(error instanceof ExecutionLost) && !this.closing) {
        const reason = error instanceof BudgetExhausted ? 'budget_exhausted'
          : error instanceof DomainError && ['forbidden', 'not_found'].includes(error.code) ? 'permission_revoked'
          : controller.signal.aborted ? 'cancelled_or_interrupted' : 'execution_error';
        try { await this.coordinator.stop(scope, reason); }
        catch (stopError) { if (!(stopError instanceof ExecutionLost)) throw stopError; }
      }
    } finally {
      clearInterval(timer); await heartbeat; this.abort = undefined;
    }
  }

  close(): Promise<void> {
    this.closing = true; this.abort?.abort();
    this.closePromise ??= (async () => { try { await this.active; } finally { await this.saver.end(); } })();
    return this.closePromise;
  }
}
