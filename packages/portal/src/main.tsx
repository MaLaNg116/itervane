import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { z } from 'zod';
import { PortalApp } from './app.js';
import './style.css';

// Browser CSP forbids eval; use Zod's interpreted validation instead of probing JIT compilation.
z.config({ jitless: true });
const root = document.getElementById('root');
if (!root) throw new Error('Portal root unavailable');
createRoot(root).render(<StrictMode><PortalApp /></StrictMode>);
