import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { describe, expect, it } from 'vitest';
import { KomodoNativeClient, observeUpdate, requestDeploy } from '../../src/native/komodo.js';

const target = '2'.repeat(24);
const update = '3'.repeat(24);
const actor = '4'.repeat(24);

async function withCore(
  serve: (request: IncomingMessage, response: ServerResponse) => void,
  inspect: (client: KomodoNativeClient) => Promise<void>,
) {
  const server = createServer(serve);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Invalid local transport');
    await inspect(new KomodoNativeClient('http://127.0.0.1:' + address.port, { key: 'fixture', secret: 'test-only' }));
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
}

describe('P0 native Komodo protocol', () => {
  it('uses one write and checks the exact native operation, target and actor on a separate read', async () => {
    const calls: string[] = [];
    await withCore((req, res) => {
      calls.push(req.url ?? '');
      expect(req.headers['x-api-key']).toBe('fixture');
      expect(req.headers['x-api-secret']).toBe('test-only');
      req.resume();
      const body = req.url === '/execute/Deploy'
        ? { _id: { $oid: update } }
        : { _id: { $oid: update }, operation: 'Deploy', target: { type: 'Deployment', id: target }, operator: actor, status: 'Complete', success: true };
      res.end(JSON.stringify(body));
    }, async client => {
      const id = await requestDeploy(client, target);
      expect(id).toBe(update);
      await expect(observeUpdate(client, id, target, actor)).resolves.toBe(true);
    });
    expect(calls).toEqual(['/execute/Deploy', '/read/GetUpdate']);
  });

  it('blocks redirects and leaves the dispatch result unknown', async () => {
    const calls: string[] = [];
    await withCore((req, res) => {
      calls.push(req.url ?? '');
      res.writeHead(307, { Location: '/redirected' }).end();
    }, async client => {
      await expect(requestDeploy(client, target)).rejects.toMatchObject({ step: 'Deploy', reason: 'transport' });
    });
    expect(calls).toEqual(['/execute/Deploy']);
  });

  it('rejects a completed update with different actor even if the destination claims success', async () => {
    await withCore((req, res) => {
      req.resume();
      res.end(JSON.stringify({
        _id: { $oid: update }, operation: 'Deploy', target: { type: 'Deployment', id: target },
        operator: target, status: 'Complete', success: true,
      }));
    }, async client => {
      await expect(observeUpdate(client, update, target, actor)).rejects.toMatchObject({ step: 'GetUpdate', reason: 'binding' });
    });
  });
});
