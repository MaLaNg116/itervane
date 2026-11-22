import { whiskersMcpKeySchema, whiskersNativeApprovalIdSchema } from '@itervane/contracts';
import type { CallToolResult } from '@modelcontextprotocol/client';
import {
  WhiskersMcpError, whiskersContainerBindingSchema, whiskersToolText, withWhiskersMcp,
  type WhiskersContainerBinding, type WhiskersMcpFailure,
} from './whiskers-mcp.js';

const raisedApproval = /^Human approval required: 'restart_container' \(write\) requires confirmation\. Approval ([a-f0-9]{32}) was raised \(Whiskers → Approvals\)\. After it is approved, repeat this exact call within 10 minutes; it then runs once\.$/;
const pendingApproval = /^Approval ([a-f0-9]{32}) for 'restart_container' is still pending\. Repeat this exact call once a human has approved it\.$/;
// The acknowledgement contains a display name. Independent readback verifies the actual target and health.
const restartAcknowledgement = /^Container \/?[a-zA-Z0-9][a-zA-Z0-9_.-]{0,255} restarted\.$/;

type Attempt = Readonly<{ kind: 'request' } | { kind: 'resume'; approvalId: string }>;
type Authorize = (phase: 'connect' | 'send', attempt: Attempt, target: Readonly<WhiskersContainerBinding>) => Promise<void>;
type RestartResult =
  | { status: 'awaiting_approval'; approvalId: string }
  | { status: 'acknowledged'; approvalId: string }
  | { status: 'result_unknown' };

export class WhiskersRestartError extends Error {
  constructor(readonly reason: WhiskersMcpFailure) { super('whiskers_restart_' + reason); }
}

function readRestartResult(raw: CallToolResult, attempt: Attempt): RestartResult {
  const text = whiskersToolText(raw);
  if (text && raw.isError === true) {
    const id = attempt.kind === 'request' ? raisedApproval.exec(text)?.[1] : pendingApproval.exec(text)?.[1];
    if (id && (attempt.kind === 'request' || attempt.approvalId === id)) return { status: 'awaiting_approval', approvalId: id };
  } else if (text && attempt.kind === 'resume' && restartAcknowledgement.test(text)) {
    return { status: 'acknowledged', approvalId: attempt.approvalId };
  }
  return { status: 'result_unknown' };
}

export class WhiskersRestartClient {
  readonly #binding: Readonly<WhiskersContainerBinding>;
  readonly #writeKey: string;

  constructor(binding: WhiskersContainerBinding, writeKey: string) {
    const target = whiskersContainerBindingSchema.safeParse(binding);
    const key = whiskersMcpKeySchema.safeParse(writeKey);
    if (!target.success || !key.success) throw new WhiskersRestartError('binding');
    this.#binding = Object.freeze(target.data);
    this.#writeKey = key.data;
  }

  requestApproval(authorize: Authorize, signal?: AbortSignal) {
    return this.attempt(Object.freeze({ kind: 'request' }), authorize, signal);
  }

  resume(approvalId: string, authorize: Authorize, signal?: AbortSignal) {
    if (!whiskersNativeApprovalIdSchema.safeParse(approvalId).success) throw new WhiskersRestartError('binding');
    return this.attempt(Object.freeze({ kind: 'resume', approvalId }), authorize, signal);
  }

  private async attempt(attempt: Attempt, authorize: Authorize, signal?: AbortSignal): Promise<RestartResult> {
    signal?.throwIfAborted();
    await authorize('connect', attempt, this.#binding);
    let mayHaveSent = false;
    try {
      return await withWhiskersMcp(this.#binding, this.#writeKey, 'restart', signal, async (invoke, requireTime) => {
        await authorize('send', attempt, this.#binding);
        requireTime();
        mayHaveSent = true;
        return readRestartResult(await invoke('restart_container'), attempt);
      });
    } catch (error) {
      if (mayHaveSent) return { status: 'result_unknown' };
      if (error instanceof WhiskersMcpError) throw new WhiskersRestartError(error.reason);
      throw error;
    }
  }
}
