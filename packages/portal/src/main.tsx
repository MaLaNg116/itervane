import './browser-policy.js';
import './style.css';

// The async boundary keeps shared-schema construction after CSP-safe Zod configuration, even after bundling.
void import('./bootstrap.js');
