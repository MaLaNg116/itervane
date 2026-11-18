import { defineConfig } from 'vite';

export default defineConfig({ build: { target: 'es2022', sourcemap: false,
  rolldownOptions: { onwarn(warning, warn) {
    // This bundle is a client-only SPA; dependency RSC boundaries do not apply.
    if (warning.code === 'MODULE_LEVEL_DIRECTIVE' && warning.message.includes('use client')) return;
    warn(warning);
  } },
} });
