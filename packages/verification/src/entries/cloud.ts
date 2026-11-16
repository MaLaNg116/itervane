import { executeProbe } from '../report.js';
import { probeCloud } from '../cloud.js';

process.exitCode = await executeProbe('cloud', () => probeCloud());
