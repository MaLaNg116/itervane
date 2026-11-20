import { sha256 } from '@itervane/agent';
import { createAnthropic, createOpenAI, safeEndpoint } from '@itervane/model';

export function localModel(env = process.env) {
  const protocol = env.MODEL_PROVIDER ?? 'anthropic';
  if (protocol !== 'anthropic' && protocol !== 'openai') return;
  const prefix = protocol.toUpperCase();
  const baseURL = env[`${prefix}_BASE_URL`];
  const apiKey = env[`${prefix}_API_KEY`];
  const model = env[`${prefix}_MODEL`];
  if (!baseURL || !apiKey || !model) return;
  try {
    const endpoint = safeEndpoint(baseURL);
    if (!['localhost', '127.0.0.1', '[::1]'].includes(new URL(endpoint).hostname)) return;
    const connect = protocol === 'anthropic' ? createAnthropic : createOpenAI;
    return { adapter: connect({ baseURL: endpoint, apiKey, model }), providerSha256: sha256(JSON.stringify({ protocol, baseURL: endpoint, model })) };
  } catch {
    return;
  }
}
