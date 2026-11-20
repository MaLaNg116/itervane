import assert from 'node:assert/strict';
import { once } from 'node:events';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { createApp } from '../server/app.mjs';

async function withServer(options, run) {
  const server = createApp(options).listen(0, '127.0.0.1');
  await once(server, 'listening');
  try { await run(`http://127.0.0.1:${server.address().port}`); }
  finally { await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
}

test('health and runtime version agree, and sample data is synthetic', async () => {
  await withServer({ version: 'candidate-a' }, async base => {
    const health = await fetch(`${base}/health`);
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { status: 'healthy', version: 'candidate-a' });
    assert.deepEqual(await (await fetch(`${base}/api/version`)).json(), { version: 'candidate-a' });
    const data = await (await fetch(`${base}/api/demo`)).json();
    assert.equal(data.synthetic, true);
    assert.equal(data.items.length, 2);
  });
});

test('unhealthy profile has a real 503 response, rather than a success flag', async () => {
  await withServer({ mode: 'unhealthy' }, async base => {
    const response = await fetch(`${base}/health`);
    assert.equal(response.status, 503);
    assert.equal((await response.json()).status, 'unhealthy');
  });
});

test('HTTP requests cannot switch the fault profile', async () => {
  await withServer({}, async base => {
    assert.equal((await fetch(`${base}/admin/mode`, { method: 'POST', body: 'unhealthy' })).status, 404);
    assert.equal((await fetch(`${base}/health`)).status, 200);
  });
});

test('startup-failure exits before serving and logs only the synthetic marker', () => {
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('../server/index.mjs', import.meta.url))], {
    env: { ITERVANE_FIXTURE_MODE: 'startup-failure', SystemRoot: process.env.SystemRoot },
    encoding: 'utf8', timeout: 5_000,
  });
  assert.equal(result.status, 42);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr.trim(), 'fixture-startup-failure');
});

test('built React page and compiled assets are served by the same Express application', async () => {
  await withServer({}, async base => {
    const response = await fetch(base);
    assert.equal(response.status, 200);
    const html = await response.text();
    assert.match(html, /Itervane sample application/);
    const script = /src="(\/assets\/[^\"]+\.js)"/.exec(html)?.[1];
    assert.ok(script);
    assert.equal((await fetch(`${base}${script}`)).status, 200);
  });
});
