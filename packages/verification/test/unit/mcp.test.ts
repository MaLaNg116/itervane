import { expect, it } from 'vitest';
import { probeMcp } from '../../src/mcp.js';

it('authenticates MCP over HTTP, rejects hostile origins and reconnects', async () => {
  const result = await probeMcp();
  expect(result.status).toBe('passed');
  expect(result.checks.map(c => c.id)).toContain('external-client-reconnect');
});
