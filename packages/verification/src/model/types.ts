export type ToolDefinition = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
};
export type ToolCall = { id: string; name: string; input: unknown };
export type ToolObservation = { callId: string; name: string; output: string; isError: boolean };
export type ModelTurn = { text: string; calls: ToolCall[]; tokenUsage: number };
export type ConversationEntry =
  | { kind: 'user'; text: string }
  | { kind: 'assistant'; turn: ModelTurn }
  | { kind: 'observations'; observations: ToolObservation[] };

export interface ModelAdapter {
  readonly protocol: 'anthropic' | 'openai';
  complete(input: {
    system: string;
    conversation: ConversationEntry[];
    tools: ToolDefinition[];
    signal: AbortSignal;
  }): Promise<ModelTurn>;
}

export function safeEndpoint(input: string): string {
  const url = new URL(input);
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback))
      || url.username || url.password || url.search || url.hash) {
    throw new Error('Model endpoint must use HTTPS, or HTTP on loopback, without embedded credentials');
  }
  return url.toString().replace(/\/$/, '');
}

// Never forward a credential to a redirect target supplied by an endpoint.
export const privateFetch: typeof fetch = (input, init) => fetch(input, { ...init, redirect: 'error' });
