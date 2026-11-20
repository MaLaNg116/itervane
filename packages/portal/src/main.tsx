import './browser-policy.js';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { PortalApp } from './app.js';
import './style.css';

const root = document.getElementById('root');
if (!root) throw new Error('Portal root unavailable');
createRoot(root).render(<StrictMode><PortalApp /></StrictMode>);
