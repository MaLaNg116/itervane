import { Client, StreamableHTTPClientTransport, type CallToolResult } from '@modelcontextprotocol/client';

export const whiskersOrigin = 'http://127.0.0.1:49220';
export const whiskersVersion = '0.15.0';
export const restartTool = 'restart_container';
export const observeTool = 'get_container_details';
const containerIdPattern = /^[a-f0-9]{64}$/;

export function toolText(result: CallToolResult): string | undefined {
  const block = result.content[0];
  if (result.content.length !== 1 || block?.type !== 'text' || block.text.length > 8192) return;
  return block.text;
}

export function confirmationId(result: CallToolResult): string | undefined {
  if (!result.isError) return;
  const text = toolText(result);
  if (!text) return;
  const newApproval = /^Human approval required: 'restart_container' \(write\) requires confirmation\. Approval ([a-f0-9]{32}) was raised\b/.exec(text);
  const pending = /^Approval ([a-f0-9]{32}) for 'restart_container' is still pending\./.exec(text);
  return newApproval?.[1] ?? pending?.[1];
}

export class WhiskersProbeClient {
  private readonly client = new Client({ name: 'itervane-native-whiskers-probe', version: '1.0.0' });

  async connect(key: string) {
    if (!/^[a-f0-9]{64}$/.test(key)) throw new Error('Invalid fixture MCP key format');
    await this.client.connect(new StreamableHTTPClientTransport(new URL('/mcp', whiskersOrigin), {
      requestInit: { headers: { Authorization: 'Bearer ' + key }, redirect: 'error' },
    }));
    const server = this.client.getServerVersion();
    if (!server || !/whiskers/i.test(server.name)) throw new Error('Unexpected MCP server identity');
    const result = await this.client.listTools();
    if (![observeTool, restartTool].every(name => result.tools.some(tool => tool.name === name))) {
      throw new Error('Native tools missing');
    }
  }

  async observe(containerId: string) {
    return this.call(observeTool, containerId);
  }

  async restartScopeFacts() {
    const uri = 'whiskers://me/permissions';
    const { contents } = await this.client.readResource({ uri }, { timeout: 5_000 });
    const entry = contents[0];
    const value = entry && 'text' in entry ? entry.text : '';
    const lines = value.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
    return {
      blocks: contents.length,
      uriMatches: entry?.uri === uri,
      textLines: lines.length,
      namedKey: lines[1]?.startsWith('- Caller: API key "') ?? false,
      explicitScope: lines.includes('- Scope: explicit tool list'),
      oneTool: lines.includes('## Tools I may call (1)'),
      restartListed: lines.includes('- `restart_container`'),
    };
  }

  async restart(containerId: string) {
    return this.call(restartTool, containerId);
  }

  async close() {
    await this.client.close();
  }

  private async call(name: typeof observeTool | typeof restartTool, containerId: string) {
    if (!containerIdPattern.test(containerId)) throw new Error('Invalid fixture target');
    return this.client.callTool({ name, arguments: { containerId, serverId: 'local' } }, { timeout: 25_000 });
  }
}
