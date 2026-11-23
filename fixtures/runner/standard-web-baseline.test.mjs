import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { checkStandardWebApp } from './standard-web-baseline.mjs';

const version = 'fixture-version';
const healthy = { status: 'healthy', version };

async function measure({ followup, nextStatus, nextBody }) {
  let requests = 0;
  const server = createServer((request, response) => {
    const json = (status, body) => response.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
    if (request.url === '/health') return ++requests === 1 ? json(200, healthy) : json(nextStatus, nextBody);
    if (request.url === '/api/version') return json(200, { version });
    if (request.url === '/api/demo') return json(200, { synthetic: true, items: ['a', 'b'] });
    if (request.url === '/') return response.writeHead(200, { 'content-type': 'text/html' })
      .end('Itervane sample application<script type="module" src="/assets/test.js"></script>');
    response.writeHead(200, { 'content-type': 'text/javascript' }).end('void 0;');
  }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const report = await checkStandardWebApp({ port: server.address().port, expectedVersion: version, healthFollowup: followup });
    assert.equal(report.status, 'passed');
    assert.equal(report.checks.length, 5);
    assert.deepEqual(report.checks[0], { id: 'health', status: 'passed', code: null, statusCode: 200 });
    return { requests, followup: report.healthFollowup };
  } finally { await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
}

test('the ordinary baseline probes health once', async () => {
  assert.deepEqual(await measure({ followup: false, nextStatus: 503, nextBody: {} }), { requests: 1, followup: undefined });
});

test('the follow-up records a same-version healthy response', async () => {
  assert.deepEqual(await measure({ followup: true, nextStatus: 200, nextBody: healthy }), {
    requests: 2, followup: { status: 'passed', code: null, statusCode: 200 },
  });
});

test('the follow-up verifies the version and body before treating 503 as an application failure', async () => {
  const observe = async nextVersion => (await measure({ followup: true, nextStatus: 503,
    nextBody: { status: 'unhealthy', version: nextVersion } })).followup;
  assert.deepEqual(await observe(version), { status: 'unhealthy', code: 'application_unhealthy', statusCode: 503 });
  assert.deepEqual(await observe('another-version'), { status: 'unavailable', code: 'unexpected_content', statusCode: 503 });
});
