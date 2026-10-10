import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

function normaliseBase(raw: string | undefined): string {
  let base = (raw ?? '/').trim() || '/';
  if (!base.startsWith('/')) base = `/${base}`;
  if (!base.endsWith('/')) base = `${base}/`;
  return base;
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const base = normaliseBase(env.VITE_BASE_PATH);

  return {
    base,
    define: {
      __APP_BASE__: JSON.stringify(base),
    },
    worker: { format: 'es' },
    build: {
      target: 'es2020',
      chunkSizeWarningLimit: 4000,
    },
    plugins: [
      react(),
      VitePWA({
        registerType: 'prompt',
        injectRegister: false,
        includeAssets: ['icons/*.png', 'icons/*.svg', 'fonts/*.woff2'],
        manifest: {
          name: 'Riffi – music practice',
          short_name: 'Riffi',
          description: 'Practise violin, piano and singing with a friendly helper that listens and cheers you on.',
          lang: 'en-AU',
          start_url: base,
          scope: base,
          display: 'standalone',
          orientation: 'any',
          background_color: '#FFF8F0',
          theme_color: '#6C4DF5',
          categories: ['education', 'music', 'kids'],
          icons: [
            { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png' },
            { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png' },
            { src: 'icons/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
          ],
        },
        workbox: {
          globPatterns: ['**/*.{js,css,html,svg,png,woff2,webmanifest,json,bin,wasm}'],
          maximumFileSizeToCacheInBytes: 8 * 1024 * 1024,
          navigateFallback: `${base}index.html`,
          navigateFallbackDenylist: [/\/api\//],
          cleanupOutdatedCaches: true,
        },
        devOptions: { enabled: false },
      }),
    ],
    test: {
      environment: 'node',
      include: ['tests/unit/**/*.test.ts', 'tests/unit/**/*.test.tsx'],
      setupFiles: ['tests/unit/setup.ts'],
      testTimeout: 30000,
    },
  };
});
