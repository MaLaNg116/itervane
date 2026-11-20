import { probeEvaluation } from '../evaluation.js';
import { executeProbe } from '../report.js';

process.exitCode = await executeProbe('evaluation', probeEvaluation);
