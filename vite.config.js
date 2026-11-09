import { defineConfig, loadEnv } from 'vite';

// Content-Security-Policy for production builds (dev is left alone so Vite's HMR
// client and websocket keep working).
// - No 'unsafe-eval': ExcelJS only reaches Function() in fallbacks browsers never hit.
// - style-src needs 'unsafe-inline' because the markup and rendered rows use style="".
// - blob:/data: images cover chart/export previews; downloads use blob: links,
//   which CSP does not restrict.
// - connect-src adds the optional SQLite API origin from VITE_API_URL.
function contentSecurityPolicy(apiUrl) {
  let apiOrigin = '';
  if (apiUrl) {
    try {
      apiOrigin = ' ' + new URL(apiUrl).origin;
    } catch {
      throw new Error(`VITE_API_URL is not a valid URL: ${apiUrl}`);
    }
  }
  const directives = [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    `connect-src 'self'${apiOrigin}`,
    "worker-src 'self'",
    "manifest-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'none'"
  ];
  return {
    name: 'fleetpilot-csp',
    apply: 'build',
    transformIndexHtml() {
      return [{
        tag: 'meta',
        attrs: { 'http-equiv': 'Content-Security-Policy', content: directives.join('; ') },
        injectTo: 'head-prepend'
      }];
    }
  };
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), 'VITE_');

  return {
    // './' makes the built files load from relative paths, so the app works from
    // any folder: the Electron .exe (file://) and the portable folder alike.
    base: './',
    build: {
      rollupOptions: {
        output: {
          // ExcelJS is ~1 MB on its own; keep it in a separate vendor chunk.
          manualChunks: { exceljs: ['exceljs'] }
        }
      },
      chunkSizeWarningLimit: 1000
    },
    plugins: [contentSecurityPolicy(env.VITE_API_URL)]
  };
});
