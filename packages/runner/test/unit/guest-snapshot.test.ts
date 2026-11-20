import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { publishGuestSnapshot, readGuestSnapshot } from '../../src/guest-snapshot.js';
import { trustedGitFixture } from '../helpers/trusted-git.js';

describe.runIf(process.platform === 'linux')('fixed object publication inside the guest', () => {
  it('rebuilds the expected manifest and keeps the npm view tied to the verified files', async () => {
    const sample = await trustedGitFixture('sha1', {
      'app/package-lock.json': Buffer.from('{"lockfileVersion":3}\n'),
      'app/pnpm-lock.yaml': Buffer.from('lockfileVersion: 9\n'),
      'src/binary': Buffer.from([0, 255, 10]),
    });
    try {
      const base = join(sample.root, 'published'); await mkdir(base);
      const runId = randomUUID();
      expect(publishGuestSnapshot(base, sample.root, runId, sample.source)).toEqual(sample.manifest);
      const ready = join(base, 'ready');
      expect(readGuestSnapshot(ready)).toEqual({ runId, manifest: sample.manifest });
      const projected = join(ready, 'npm/app/package-lock.json');
      await rm(projected);
      await writeFile(projected, '{"lockfileVersion":3}\n');
      expect(() => readGuestSnapshot(ready)).toThrow('snapshot-inventory');
    } finally { await sample.close(); }
  });
});
