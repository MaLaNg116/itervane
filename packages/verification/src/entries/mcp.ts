import { executeProbe } from '../report.js';
import { probeMcp } from '../mcp.js';

process.exitCode = await executeProbe('mcp', probeMcp);
