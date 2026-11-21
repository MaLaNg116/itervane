import { z } from 'zod';
import { sha256 } from './profiles.js';

export const buildLockByteLimit = 512 * 1024;
const registry = 'https://registry.npmjs.org/';
const packageName = '(?:@[a-z0-9][a-z0-9._-]*/)?[a-z0-9][a-z0-9._-]*';
const packagePath = new RegExp(`^(?:node_modules/${packageName}/)*node_modules/(${packageName})$`);
const version = z.string().max(128).regex(/^[0-9]+\.[0-9]+\.[0-9]+(?:-[a-zA-Z0-9.-]+)?$/);
const platformList = z.array(z.string().regex(/^!?[a-z0-9-]{1,32}$/)).max(32).optional();
const lockedPackage = z.object({
  version, resolved: z.string().min(1).max(512), integrity: z.string().regex(/^sha512-[a-zA-Z0-9+/]{86}==$/),
  optional: z.boolean().optional(), os: platformList, cpu: platformList, libc: platformList,
  link: z.literal(false).optional(), inBundle: z.literal(false).optional(),
});
const lock = z.object({
  lockfileVersion: z.literal(3),
  packages: z.record(z.string().max(512), z.unknown()),
});

function matchesPlatform(values: string[] | undefined, selected: string) {
  if (!values?.length) return true;
  const allow = values.filter(value => !value.startsWith('!'));
  return !values.includes(`!${selected}`) && (!allow.length || allow.includes(selected) || allow.includes('any'));
}

/** Read only explicit registry tarballs needed by the Linux amd64 build profile. */
export function readBuildDependencies(bytes: Uint8Array) {
  if (bytes.byteLength > buildLockByteLimit) throw new Error('build_lock_limit');
  const { packages } = lock.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)));
  const entries = Object.entries(packages);
  if (!Object.hasOwn(packages, '') || entries.length < 2 || entries.length > 513) throw new Error('build_lock_packages');
  const dependencies = new Map<string, string>();
  for (const [path, raw] of entries) {
    if (!path) continue;
    const name = packagePath.exec(path)?.[1];
    if (!name) throw new Error('build_lock_path');
    const item = lockedPackage.parse(raw);
    const base = name.slice(name.lastIndexOf('/') + 1);
    if (item.resolved !== `${registry}${name}/-/${base}-${item.version}.tgz`) throw new Error('build_lock_registry');
    const digest = item.integrity.slice(7);
    if (Buffer.from(digest, 'base64').toString('base64') !== digest) throw new Error('build_lock_integrity');
    const supported = matchesPlatform(item.os, 'linux') && matchesPlatform(item.cpu, 'x64') && matchesPlatform(item.libc, 'glibc');
    if (!supported) {
      if (!item.optional) throw new Error('build_lock_platform');
      continue;
    }
    const previous = dependencies.get(item.resolved);
    if (previous && previous !== item.integrity) throw new Error('build_lock_conflict');
    dependencies.set(item.resolved, item.integrity);
  }
  if (!dependencies.size) throw new Error('build_lock_packages');
  return { lockSha256: sha256(bytes), tarballs: [...dependencies.keys()].sort().map(url => ({ url, integrity: dependencies.get(url)! })) };
}
