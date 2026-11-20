import { executeProbe } from '../report.js';
import { probeModel } from '../model/probe.js';

process.exitCode = await executeProbe('model', () => probeModel());
