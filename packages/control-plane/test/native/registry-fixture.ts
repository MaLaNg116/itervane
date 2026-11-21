import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const registryImage = 'docker.io/library/registry:3@sha256:52b489ad8e6f40d1a676702e3ce398ec796ce38f08fbb786e1f324baa12d84b8';

export async function temporaryRegistry() {
  const nonce = randomUUID();
  const name = `itervane-fixture-registry-${nonce}`;
  const close = async () => {
    const label = await execute('docker', ['inspect', '--format', '{{index .Config.Labels "io.itervane.test"}}', name],
      { timeout: 10_000 }).catch(() => undefined);
    if (label?.stdout.trim() === nonce) await execute('docker', ['rm', '--force', name], { timeout: 15_000 });
  };
  try {
    await execute('docker', ['run', '--detach', '--rm', '--name', name, '--label', `io.itervane.test=${nonce}`,
      '--publish', '127.0.0.1::5000', '--tmpfs', '/var/lib/registry:rw,size=512m', registryImage],
    { timeout: 180_000 });
    const mapping = await execute('docker', ['port', name, '5000/tcp'], { timeout: 10_000 });
    const bound = /^127\.0\.0\.1:[1-9][0-9]{0,4}$/.exec(mapping.stdout.trim());
    if (!bound) throw new Error('native_registry_binding');
    const origin = `http://${bound[0]}`;
    for (let attempt = 0; attempt < 40; attempt++) {
      const response = await fetch(`${origin}/v2/`, { redirect: 'error', signal: AbortSignal.timeout(1000) }).catch(() => null);
      await response?.body?.cancel();
      if (response?.ok) return { origin, close };
      await delay(250);
    }
    throw new Error('native_registry_not_ready');
  } catch {
    await close();
    throw new Error('native_registry_fixture_unavailable');
  }
}
