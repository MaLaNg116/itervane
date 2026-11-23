import express from 'express';
import { fileURLToPath } from 'node:url';

export function createApp({ mode = 'healthy', version = '0.1.0' } = {}) {
  if (!['healthy', 'unhealthy'].includes(mode)) throw new Error('Unsupported fixture mode');
  if (!/^[a-zA-Z0-9_.-]{1,64}$/.test(version)) throw new Error('Invalid fixture version');
  const app = express();
  app.disable('x-powered-by');
  app.use((_request, response, next) => {
    response.set('X-Content-Type-Options', 'nosniff');
    response.set('Cache-Control', 'no-store');
    next();
  });
  let healthRequests = 0;
  app.get('/health', (_request, response) => {
    if (++healthRequests > 1) {
      console.error('ERROR fixture-health-repeat');
      return response.status(503).json({ status: 'unhealthy', version });
    }
    response.status(mode === 'healthy' ? 200 : 503).json({ status: mode, version });
  });
  app.get('/api/version', (_request, response) => response.json({ version }));
  app.get('/api/demo', (_request, response) => response.json({
    synthetic: true,
    items: [{ id: 'sample-a', label: 'Synthetic example A' }, { id: 'sample-b', label: 'Synthetic example B' }],
  }));
  app.use(express.static(fileURLToPath(new URL('../dist/', import.meta.url))));
  app.use((_request, response) => response.status(404).json({ error: 'not_found' }));
  return app;
}
