import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { readBuildDependencies } from '../../src/build-dependencies.js';
import { sha256 } from '../../src/profiles.js';

const fixture = new URL('../../../../fixtures/standard-app/package-lock.json', import.meta.url);
const integrity = `sha512-${Buffer.alloc(64, 4).toString('base64')}`;
const url = 'https://registry.npmjs.org/sample/-/sample-1.2.3.tgz';
const item = { version: '1.2.3', integrity, resolved: url };
const lock = (packages: Record<string, unknown>) =>
  Buffer.from(JSON.stringify({ lockfileVersion: 3, packages: { '': { name: 'fixture' }, ...packages } }));

describe('protected build dependency input', () => {
  it('selects registry tarballs for the standard application and binds the exact lock bytes', () => {
    const bytes = readFileSync(fixture);
    const input = readBuildDependencies(bytes);
    expect(input.lockSha256).toBe(sha256(bytes));
    const urls = input.tarballs.map(tarball => tarball.url);
    expect(urls).toContain('https://registry.npmjs.org/express/-/express-5.3.0.tgz');
    expect(urls.some(address => address.includes('binding-linux-x64-gnu'))).toBe(true);
    expect(urls.some(address => address.includes('binding-darwin'))).toBe(false);
  });

  it('deduplicates a shared registry tarball and skips only incompatible optional packages', () => {
    const input = readBuildDependencies(lock({
      'node_modules/sample': item, 'node_modules/other/node_modules/sample': item,
      'node_modules/windows-only': { ...item, resolved: url.replaceAll('sample', 'windows-only'), os: ['win32'], optional: true },
    }));
    expect(input.tarballs).toEqual([{ url, integrity }]);
  });

  it.each([
    { ...item, resolved: url.replace('registry.npmjs.org', 'example.invalid') },
    { ...item, resolved: url.replace('sample-1.2.3', 'sample-1.2.4') },
    { ...item, resolved: 'file:sample.tgz', link: true },
    { ...item, integrity: 'sha1-weak' },
    { ...item, os: ['darwin'] },
  ])('rejects a lock entry outside the protected dependency scope', entry => {
    expect(() => readBuildDependencies(lock({ 'node_modules/sample': entry }))).toThrow();
  });
});
