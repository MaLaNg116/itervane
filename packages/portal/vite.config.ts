import { defineConfig } from 'vite';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({ plugins: [tailwindcss()], build: { target: 'es2022', sourcemap: false, license: { fileName: 'third-party-licenses.md' },
  rolldownOptions: { output: { comments: { legal: true }, banner: '/*! Itervane portal. GSAP / @gsap/react: Copyright GreenSock; https://gsap.com/standard-license . Third-party notices in third-party-licenses.md; shadcn/ui source notice in shadcn-LICENSE.txt. */' }, onwarn(warning, warn) {
    // This bundle is a client-only SPA; dependency RSC boundaries do not apply.
    if (warning.code === 'MODULE_LEVEL_DIRECTIVE' && warning.message.includes('use client')) return;
    warn(warning);
  } },
} });
