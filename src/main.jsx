import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './style.css';

function App() {
  const [result, setResult] = useState({ state: 'loading' });
  useEffect(() => {
    const controller = new AbortController();
    Promise.all(['/health', '/api/version', '/api/demo'].map(async path => {
      const response = await fetch(path, { signal: controller.signal });
      if (!response.ok) throw new Error('Service unavailable');
      return response.json();
    })).then(([health, version, demo]) => setResult({ state: 'ready', health, version, demo }))
      .catch(error => { if (error.name !== 'AbortError') setResult({ state: 'error' }); });
    return () => controller.abort();
  }, []);
  return <main>
    <p className="eyebrow">ITERVANE · REFERENCE FIXTURE</p>
    <h1>A small app for a complete delivery loop.</h1>
    <p>Synthetic data only. This sample is used to verify builds, release versions, health checks, and recovery.</p>
    <section aria-live="polite">
      {result.state === 'loading' && <p>Checking service…</p>}
      {result.state === 'error' && <p role="alert">The service is unavailable.</p>}
      {result.state === 'ready' && <>
        <p><strong>Service:</strong> {result.health.status} · <strong>Version:</strong> {result.version.version}</p>
        <ul>{result.demo.items.map(item => <li key={item.id}>{item.label}</li>)}</ul>
      </>}
    </section>
  </main>;
}

createRoot(document.getElementById('root')).render(<App />);
