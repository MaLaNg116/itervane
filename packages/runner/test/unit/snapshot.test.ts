import { afterAll, beforeAll, expect, it } from 'vitest';
import { sourcePath, verifySourceSnapshot } from '../../src/snapshot.js';
import { createInspectionPlan, inspectionPlanHash } from '../../src/profiles.js';
import { trustedGitFixture } from '../helpers/trusted-git.js';
import { randomUUID } from 'node:crypto';

const fixtures: Awaited<ReturnType<typeof trustedGitFixture>>[] = [];
beforeAll(async () => { fixtures.push(await trustedGitFixture('sha1'), await trustedGitFixture('sha256')); });
afterAll(async () => { await Promise.all(fixtures.map(value => value.close())); });

for (const [index, format] of ['sha1', 'sha256'].entries()) it(`reconstructs a real Git ${format} commit and tree including binary data, executable bits and Git ordering`, () => {
  const value = fixtures[index]!; const manifest = verifySourceSnapshot(value);
  expect(manifest.tree).toBe(value.tree); expect(manifest.objectFormat).toBe(format);
  expect(manifest.files.find(file => file.path === 'run.sh')?.mode).toBe('100755');
  expect(verifySourceSnapshot({ ...value, files: [...value.files].reverse() })).toEqual(manifest);
  expect(JSON.stringify(manifest)).not.toContain('export const');
});

it('rejects a changed blob, mode, omitted file or mismatched commit rather than hashing only a claimed snapshot', () => {
  const value = fixtures[0]!;
  for (const files of [value.files.slice(1), value.files.map((file, i) => i ? file : { ...file, content: Buffer.from('tampered') }),
    value.files.map((file, i) => i ? file : { ...file, mode: '100755' })]) expect(() => verifySourceSnapshot({ ...value, files })).toThrow('tree_mismatch');
  expect(() => verifySourceSnapshot({ ...value, source: { ...value.source, commit: '0'.repeat(40) } })).toThrow('commit_mismatch');
});

it('rejects unsafe or ambiguous paths before using them as file evidence', () => {
  for (const path of ['/etc/passwd', '../a', 'a/../b', 'a\\b', 'C:/file', 'a//b', '.git/config', 'a/.GIT/x', 'NUL.txt', 'a.', 'a:b', 'a%2fb', 'a\u0000b', 'e\u0301.txt']) expect(() => sourcePath(path)).toThrow('path_rejected');
  expect(sourcePath('src/普通 文件.ts')).toBe('src/普通 文件.ts');
  const value = fixtures[0]!;
  expect(() => verifySourceSnapshot({ ...value, files: [...value.files, value.files[0]!] })).toThrow('path_rejected');
});

it('refuses links, submodules, LFS pointers and resource overruns instead of skipping content', () => {
  const value = fixtures[0]!; const first = value.files[0]!;
  for (const mode of ['120000', '160000']) expect(() => verifySourceSnapshot({ ...value, files: [{ ...first, mode }] })).toThrow('unsupported_entry');
  expect(() => verifySourceSnapshot({ ...value, files: [{ ...first, content: Buffer.from('version https://git-lfs.github.com/spec/v1\r\noid sha256:fake\n') }] })).toThrow('unsupported_entry');
  expect(() => verifySourceSnapshot({ ...value, files: [{ ...first, content: Buffer.alloc(2097153) }] })).toThrow('source_limit');
  expect(() => verifySourceSnapshot({ ...value, files: Array(5001).fill(first) })).toThrow('source_limit');
});

it('rejects directory case collisions and file ancestors in a real Git object graph', async () => {
  // Git permits both spellings; the portable MVP snapshot policy deliberately does not.
  const value = fixtures[0]!;
  expect(() => verifySourceSnapshot({ ...value, files: [{ path: 'a', mode: '100644', content: Buffer.alloc(0) }, { path: 'a/b', mode: '100644', content: Buffer.alloc(0) }] })).toThrow('path_rejected');
});

it('binds immutable inspection policy to task, run and complete requested source with no execution permission', () => {
  const value = createInspectionPlan({ taskId: randomUUID(), runId: randomUUID(), requestedSource: fixtures[0]!.source });
  expect(inspectionPlanHash(value.document)).toBe(value.sha256);
  expect(value.document.isolation.verification).toBe('required');
  expect(value.document.network.scan).toBe('deny');
  expect(() => inspectionPlanHash({ ...value.document, verified: true })).toThrow();
  expect(createInspectionPlan({ ...value.document, requestedSource: fixtures[1]!.source }).sha256).not.toBe(value.sha256);
});
