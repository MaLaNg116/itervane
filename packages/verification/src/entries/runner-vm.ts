import { executeProbe } from '../report.js';
import { probeRunnerVm } from '../runner-vm.js';

process.exitCode = await executeProbe('runner-vm', () => probeRunnerVm());
