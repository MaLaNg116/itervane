import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import type { MessageParam } from '@anthropic-ai/sdk/resources/messages';
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';
import { privateFetch, safeEndpoint, type ConversationEntry, type ModelAdapter, type ModelTurn } from './types.js';

type Config = { apiKey: string; model: string; baseURL: string };

export function anthropicMessages(entries: ConversationEntry[]): MessageParam[] {
  return entries.map(entry => {
    if (entry.kind === 'user') return { role: 'user', content: entry.text };
    if (entry.kind === 'observations') return {
      role: 'user', content: entry.observations.map(o => ({
        type: 'tool_result', tool_use_id: o.callId, content: o.output, is_error: o.isError,
      })),
    };
    return { role: 'assistant', content: [
      ...(entry.turn.text ? [{ type: 'text' as const, text: entry.turn.text }] : []),
      ...entry.turn.calls.map(c => ({ type: 'tool_use' as const, id: c.id, name: c.name, input: c.input })),
    ] };
  });
}

export function openaiMessages(system: string, entries: ConversationEntry[]): ChatCompletionMessageParam[] {
  const result: ChatCompletionMessageParam[] = [{ role: 'system', content: system }];
  for (const entry of entries) {
    if (entry.kind === 'user') result.push({ role: 'user', content: entry.text });
    else if (entry.kind === 'observations') {
      result.push(...entry.observations.map(o => ({ role: 'tool' as const, tool_call_id: o.callId, content: o.output })));
    } else result.push({
      role: 'assistant', content: entry.turn.text || null,
      ...(entry.turn.calls.length ? { tool_calls: entry.turn.calls.map(c => ({
        id: c.id, type: 'function' as const, function: { name: c.name, arguments: JSON.stringify(c.input) },
      })) } : {}),
    });
  }
  return result;
}

export function createAnthropic(config: Config): ModelAdapter {
  const client = new Anthropic({ apiKey: config.apiKey, baseURL: safeEndpoint(config.baseURL), fetch: privateFetch, maxRetries: 0 });
  return {
    protocol: 'anthropic',
    async complete({ system, conversation, tools, signal, maxOutputTokens = 1_024 }): Promise<ModelTurn> {
      const response = await client.messages.create({
        model: config.model, max_tokens: maxOutputTokens, system,
        messages: anthropicMessages(conversation),
        tools: tools.map(t => ({ name: t.name, description: t.description, input_schema: { ...t.inputSchema, type: 'object' } })),
      }, { signal });
      return {
        text: response.content.filter(b => b.type === 'text').map(b => b.text).join('\n'),
        calls: response.content.filter(b => b.type === 'tool_use').map(b => ({ id: b.id, name: b.name, input: b.input })),
        tokenUsage: response.usage.input_tokens + response.usage.output_tokens,
      };
    },
  };
}

export function createOpenAI(config: Config): ModelAdapter {
  const client = new OpenAI({ apiKey: config.apiKey, baseURL: safeEndpoint(config.baseURL), fetch: privateFetch, maxRetries: 0 });
  return {
    protocol: 'openai',
    async complete({ system, conversation, tools, signal, maxOutputTokens = 1_024 }): Promise<ModelTurn> {
      const response = await client.chat.completions.create({
        model: config.model, messages: openaiMessages(system, conversation), max_completion_tokens: maxOutputTokens,
        tools: tools.map(t => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.inputSchema } })),
      }, { signal });
      const message = response.choices[0]?.message;
      if (!message) throw new Error('Model returned no choice');
      if (!response.usage) throw new Error('Model omitted usage; token budget cannot be verified');
      return {
        text: message.content ?? '',
        calls: (message.tool_calls ?? []).filter(c => c.type === 'function').map(c => ({
          id: c.id, name: c.function.name, input: JSON.parse(c.function.arguments) as unknown,
        })),
        tokenUsage: response.usage.total_tokens,
      };
    },
  };
}
