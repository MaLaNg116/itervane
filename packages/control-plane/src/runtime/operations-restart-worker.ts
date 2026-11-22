import { ExecutionLost } from './authority.js';
import type { OperationsExecutionCoordinator, OperationsExecutionLease } from './operations-execution-lease.js';
import type { WhiskersRestartClient } from './whiskers-restart.js';
import { loadWhiskersWriter, WhiskersWriterInstallationRejected, type WhiskersWriterFiles } from './whiskers-writer-installation.js';

type RestartDispatchStatus = 'awaiting_approval' | 'reconciling' | 'not_sent' | 'lease_lost';

export class OperationsRestartWorker {
  readonly #writeKey: string;

  constructor(private readonly execution: OperationsExecutionCoordinator, private readonly files: WhiskersWriterFiles, writeKey: string) {
    this.#writeKey = writeKey;
  }

  async dispatch(scope: OperationsExecutionLease, signal?: AbortSignal): Promise<RestartDispatchStatus> {
    if (scope.mode === 'reconcile') return 'reconciling';
    const controller = new AbortController();
    const live = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    let heartbeat: Promise<void> | undefined;
    const timer = setInterval(() => {
      if (heartbeat || live.aborted) return;
      heartbeat = this.execution.heartbeat(scope).catch(error => controller.abort(error)).finally(() => { heartbeat = undefined; });
    }, this.execution.leaseSeconds * 1000 / 3);

    try {
      return await this.send(scope, live);
    } catch (error) {
      if (error instanceof ExecutionLost) return 'lease_lost';
      // If the database committed an intent and its reply was lost, the durable state still forces reconciliation.
      try { return await this.execution.deferRestart(scope); }
      catch (settlement) {
        if (settlement instanceof ExecutionLost) return 'lease_lost';
        throw settlement;
      }
    } finally {
      clearInterval(timer);
      await heartbeat;
    }
  }

  private async send(scope: OperationsExecutionLease, signal: AbortSignal): Promise<RestartDispatchStatus> {
    signal.throwIfAborted();
    const installed = await loadWhiskersWriter(this.files, this.#writeKey);
    const plan = await this.execution.planRestartConnection(scope, installed.proof);
    const client = installed.connect(plan.target);
    let callSha256: string | undefined;
    const authorize: Parameters<WhiskersRestartClient['requestApproval']>[0] = async phase => {
      signal.throwIfAborted();
      if (phase === 'connect') return;
      const current = await loadWhiskersWriter(this.files, this.#writeKey);
      signal.throwIfAborted();
      if (current.proof.installationSha256 !== installed.proof.installationSha256) throw new WhiskersWriterInstallationRejected();
      if (plan.approval) {
        await this.execution.prepareRestartResume(scope, { ...current.proof, ...plan.approval });
      } else {
        const written = await this.execution.prepareDispatch(scope, current.proof);
        if (!written.restartRequest) throw new WhiskersWriterInstallationRejected();
        callSha256 = written.restartRequest.callSha256;
      }
    };

    if (plan.approval) {
      const result = await client.resume(plan.approval.approvalId, authorize, signal);
      const outcome = result.status === 'awaiting_approval' ? 'pending' : result.status === 'acknowledged' ? 'acknowledged' : 'unknown';
      const recorded = await this.execution.recordRestartResume(scope, { ...plan.approval, outcome });
      return recorded.waiting ? 'awaiting_approval' : 'reconciling';
    }
    const result = await client.requestApproval(authorize, signal);
    if (result.status !== 'awaiting_approval' || !callSha256) return this.execution.deferRestart(scope);
    const recorded = await this.execution.pauseForRestartApproval(scope, { approvalId: result.approvalId, callSha256 });
    return recorded.waiting ? 'awaiting_approval' : 'reconciling';
  }
}
