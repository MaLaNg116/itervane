import { readFileSync } from 'node:fs';
import { npmRegistryTarball, npmUpgradeApprovalSchema } from '@itervane/contracts';
import approval from '../../../../fixtures/runner/repair-input/npm-upgrade.json' with { type: 'json' };

const root = 'fixtures/runner/inspection-input/original';
export const npmFixtureApproval = npmUpgradeApprovalSchema.parse(approval);
export const npmFixturePaths = { lock: `${root}/package-lock.json`, manifest: `${root}/package.json` };

export function npmFixtureFiles() {
  const lock = readFileSync(new URL(`../../../../${npmFixturePaths.lock}`, import.meta.url), 'utf8');
  const manifest = readFileSync(new URL(`../../../../${npmFixturePaths.manifest}`, import.meta.url), 'utf8');
  const { name, installedVersion, fixedVersion, integrity } = npmFixtureApproval;
  const from = JSON.stringify(installedVersion); const to = JSON.stringify(fixedVersion);
  const oldUrl = JSON.stringify(npmRegistryTarball(name, installedVersion));
  const newUrl = JSON.stringify(npmRegistryTarball(name, fixedVersion));
  const integrityEntry = `, "integrity": ${JSON.stringify(integrity)}`;
  const lockPositions = [lock.indexOf(from), lock.lastIndexOf(from), lock.indexOf(oldUrl)];
  const manifestPosition = manifest.indexOf(from);
  if (manifestPosition < 0 || lockPositions[0]! < 0 || lockPositions[1]! <= lockPositions[0]! || lockPositions[2]! <= lockPositions[1]!) {
    throw new Error('npm_fixture_layout');
  }
  const span = (text: string, start: number, length: number, replacement: string) => {
    const startByte = Buffer.byteLength(text.slice(0, start));
    return { startByte, endByte: startByte + Buffer.byteLength(text.slice(start, start + length)), replacement };
  };
  const urlEnd = lockPositions[2]! + oldUrl.length;
  return [
    { path: npmFixturePaths.lock, original: lock, expected: lock.replaceAll(from, to).replace(oldUrl, newUrl + integrityEntry),
      edits: [span(lock, lockPositions[0]!, from.length, to), span(lock, lockPositions[1]!, from.length, to),
        span(lock, lockPositions[2]!, oldUrl.length, newUrl), span(lock, urlEnd, 0, integrityEntry)],
    },
    { path: npmFixturePaths.manifest, original: manifest, expected: manifest.replace(from, to),
      edits: [span(manifest, manifestPosition, from.length, to)] },
  ];
}
