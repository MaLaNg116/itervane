import { describe, expect, it } from 'vitest';
import { confirmationId, toolText } from '../../src/native/whiskers.js';

describe('Whiskers native approval replies', () => {
  const id = 'a'.repeat(32);
  const raised = "Human approval required: 'restart_container' (write) requires confirmation. Approval " + id + " was raised (Whiskers → Approvals).";
  const waiting = 'Approval ' + id + " for 'restart_container' is still pending. Repeat this exact call once a human has approved it.";
  const reply = (text: string, isError = true) => ({ isError, content: [{ type: 'text' as const, text }] });

  it('extracts only an actual restart confirmation or pending receipt', () => {
    expect(confirmationId(reply(raised))).toBe(id);
    expect(confirmationId(reply(waiting))).toBe(id);
    expect(confirmationId(reply(raised, false))).toBeUndefined();
    expect(confirmationId(reply(raised.replace('restart_container', 'stop_container')))).toBeUndefined();
    expect(confirmationId(reply('MCP returned HTTP 500'))).toBeUndefined();
  });

  it('rejects oversized and ambiguous tool content', () => {
    expect(toolText(reply('x'.repeat(8193)))).toBeUndefined();
    expect(toolText({ content: [...reply(raised).content, ...reply(waiting).content] })).toBeUndefined();
  });
});
