import { join } from 'node:path';
import { readGuestSnapshotData } from './guest-snapshot.js';
import { sha256 } from './profiles.js';

const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

export function repairText(bytes: Buffer) {
  try {
    const text = decoder.decode(bytes);
    return /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text) ? null : text;
  } catch { return null; }
}

export function readRepairSource(source: string, bytes: Buffer, mode: 'repair' | 'repair-observation') {
  const fixed = readGuestSnapshotData(join(source, 'ready'));
  if (fixed.mode !== mode) throw new Error('repair-integrity');
  const { manifest } = fixed;
  return { fixed, proof: {
    runId: fixed.runId, repositoryId: manifest.source.repositoryId, commit: manifest.source.commit,
    tree: manifest.tree, manifestSha256: manifest.sha256, files: manifest.files.length,
    commandSha256: sha256(bytes), readOnly: true, offline: true,
  } };
}
