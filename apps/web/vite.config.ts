import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';

/**
 * The dev server proxies the bridge's paths so the SPA can be loaded from Vite
 * on :5173 while every call still goes to :56400.
 *
 * `secure: false` because the dev certificate is self-signed unless mkcert is
 * installed. `VITE_RPC_ORIGIN` exists for the other mode: pointing the browser
 * straight at the bridge over one h2 connection. That matters because **Vite's
 * dev server is HTTP/1.1** — proxying twenty live streams through it hits the
 * browser's ~6-connections-per-origin ceiling and later streams simply never
 * open, which looks like a hung panel rather than an error.
 */
const BRIDGE = process.env.BRIDGE_ORIGIN ?? 'https://localhost:56400';

const proxy = {
  '/rpc': { target: BRIDGE, changeOrigin: true, secure: false },
  '/kv': { target: BRIDGE, changeOrigin: true, secure: false },
  '/bridge': { target: BRIDGE, changeOrigin: true, secure: false },
};

export default defineConfig({
  plugins: [sveltekit()],
  server: { proxy },
  preview: { proxy },
});
