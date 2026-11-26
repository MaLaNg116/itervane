import { initializeReference, prepareReference, referenceEnvironment } from '../reference-installation.js';

async function main(args: string[]) {
  const [action, directory, ...parameters] = args;
  if (!directory) throw new Error('reference_usage');
  if (action === 'prepare' && (parameters.length === 0 || parameters.length === 4)) {
    const [postgres = '5432', identity = '8380', api = '4310', mcpCallback = '4862'] = parameters;
    return prepareReference(directory, { postgres, identity, api, mcpCallback });
  }
  if (action === 'init' && !parameters.length) return initializeReference(directory);
  const [role] = parameters;
  if (action === 'start' && parameters.length === 1 && (role === 'api' || role === 'worker')) {
    const environment = await referenceEnvironment(directory, role);
    for (const key of Object.keys(process.env)) {
      if (/^(?:ITERVANE_|DATABASE_URL$|ANTHROPIC_|OPENAI_)/i.test(key)) delete process.env[key];
    }
    Object.assign(process.env, environment);
    if (role === 'api') await import('./server.js');
    else await import('./worker.js');
    return;
  }
  throw new Error('reference_usage');
}

try {
  const result = await main(process.argv.slice(2));
  if (result) console.log(JSON.stringify(result));
} catch (error) {
  const reason = error instanceof Error && /^reference_[a-z_]+$/.test(error.message) ? error.message : 'reference_installation_failed';
  console.error(JSON.stringify({ error: reason }));
  process.exitCode = 1;
}
