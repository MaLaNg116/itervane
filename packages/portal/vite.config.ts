import { defineConfig } from 'vite';

export default defineConfig({ build: { target: 'es2022', sourcemap: false, license: { fileName: 'third-party-licenses.md' },
  rolldownOptions: { output: { comments: { legal: true }, banner: '/*! Itervane portal. GSAP / @gsap/react: Copyright GreenSock; https://gsap.com/standard-license . Third-party notices accompany this build in third-party-licenses.md. */' }, onwarn(warning, warn) {
    // This bundle is a client-only SPA; dependency RSC boundaries do not apply.
    if (warning.code === 'MODULE_LEVEL_DIRECTIVE' && warning.message.includes('use client')) return;
    warn(warning);
  } },
} });
