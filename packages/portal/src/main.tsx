import './browser-policy.js';
import './ui/tailwind.css';
import './style.css';

// The async boundary keeps shared-schema construction after CSP-safe Zod configuration, even after bundling.
void import('./bootstrap.js');
