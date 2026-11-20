import { probeKomodoNative } from '../native/komodo-probe.js';
import { executeProbe } from '../report.js';

process.exitCode = await executeProbe('komodo-native', () => probeKomodoNative());
