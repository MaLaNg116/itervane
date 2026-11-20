import { executeProbe } from './report.js';
import { probeReadiness } from './readiness.js';

process.exitCode = await executeProbe('readiness', async () => {
  if (process.argv[2] !== 'readiness') throw new Error('Expected readiness');
  return probeReadiness();
});
