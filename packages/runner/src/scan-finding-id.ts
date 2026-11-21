import type { normalizedScannerFindingSchema } from '@itervane/contracts';
import type { z } from 'zod';
import { sha256 } from './profiles.js';

type Coordinates = Pick<z.infer<typeof normalizedScannerFindingSchema>, 'ruleId' | 'path' | 'line' | 'npm'>;

export function scanFindingId(scanner: 'gitleaks' | 'trivy', snapshotSha256: string, { ruleId, path, line, npm }: Coordinates) {
  const source = [scanner, snapshotSha256, ruleId, path, line];
  return sha256(JSON.stringify(npm ? [...source, npm.name, npm.installedVersion] : source));
}
