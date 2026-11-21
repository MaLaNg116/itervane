import { createApp } from './app.mjs';

const mode = process.env.ITERVANE_FIXTURE_MODE ?? 'healthy';
if (mode === 'startup-failure') {
  console.error('fixture-startup-failure');
  process.exit(42);
}
const port = Number(process.env.PORT ?? 3000);
if (!Number.isInteger(port) || port < 0 || port > 65_535) throw new Error('Invalid PORT');
const app = createApp({ mode, version: process.env.ITERVANE_FIXTURE_VERSION ?? '0.1.0' });
process.once('SIGUSR2', () => { app.locals.fixtureUnhealthy = true; });
const server = app.listen(port, process.env.HOST ?? '127.0.0.1', () => console.log('fixture-ready'));
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => {
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 5_000).unref();
});
