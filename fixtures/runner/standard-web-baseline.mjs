const jsonLimit = 16 * 1024;
const htmlLimit = 64 * 1024;
const assetLimit = 2 * 1024 * 1024;
const assetPath = /^\/assets\/[A-Za-z0-9_-]{1,120}\.js$/;

async function boundedBody(response, limit) {
  if (!response.body) throw new Error('missing_body');
  let size = 0;
  const chunks = [];
  for await (const chunk of response.body) {
    size += chunk.byteLength;
    if (size > limit) throw new Error('body_limit');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, size);
}

function readJson(body, type) {
  if (!/^application\/json(?:;|$)/i.test(type)) throw new Error('invalid_content_type');
  return JSON.parse(body.toString('utf8'));
}

/** Run the maintainer's fixed HTTP checks against the app in the private guest loopback. */
export async function checkStandardWebApp({ port, expectedVersion, signal }) {
  if (!Number.isInteger(port) || port < 1 || port > 65535
      || typeof expectedVersion !== 'string' || !/^[a-zA-Z0-9_.-]{1,64}$/.test(expectedVersion)) {
    throw new Error('baseline_target');
  }
  const base = `http://127.0.0.1:${port}`;
  const checks = [];
  const check = async (id, path, limit, validate) => {
    signal?.throwIfAborted();
    const deadline = AbortSignal.timeout(4_000);
    let statusCode = null;
    try {
      const response = await fetch(base + path, { redirect: 'manual', signal: signal ? AbortSignal.any([signal, deadline]) : deadline });
      statusCode = response.status;
      if (statusCode !== 200) {
        await response.body?.cancel();
        checks.push({ id, status: 'failed', code: 'unexpected_status', statusCode });
        return undefined;
      }
      const result = validate(await boundedBody(response, limit), response.headers.get('Content-Type') ?? '');
      checks.push({ id, status: result ? 'passed' : 'failed', code: result ? null : 'unexpected_content', statusCode });
      return result;
    } catch {
      signal?.throwIfAborted();
      checks.push({ id, status: 'failed', code: deadline.aborted ? 'timeout' : statusCode === null ? 'unavailable' : 'unexpected_content', statusCode });
      return undefined;
    }
  };
  await check('health', '/health', jsonLimit, (body, type) => {
    const value = readJson(body, type);
    return value?.status === 'healthy' && value.version === expectedVersion;
  });
  await check('version', '/api/version', jsonLimit, (body, type) => readJson(body, type)?.version === expectedVersion);
  await check('synthetic_data', '/api/demo', jsonLimit, (body, type) => {
    const value = readJson(body, type);
    return value?.synthetic === true && Array.isArray(value.items) && value.items.length === 2;
  });
  const script = await check('page', '/', htmlLimit, (body, type) => {
    if (!/^text\/html(?:;|$)/i.test(type)) return false;
    const html = body.toString('utf8');
    const source = /<script\s+type="module"[^>]*\ssrc="([^"]+)"/.exec(html)?.[1];
    return html.includes('Itervane sample application') && source && assetPath.test(source) ? source : false;
  });
  if (script) {
    await check('compiled_asset', script, assetLimit,
      (body, type) => body.byteLength > 0 && /^(?:text|application)\/javascript(?:;|$)/i.test(type));
  } else {
    checks.push({ id: 'compiled_asset', status: 'blocked', code: 'missing_page_asset', statusCode: null });
  }
  return { status: checks.every(result => result.status === 'passed') ? 'passed' : 'failed', checks };
}
