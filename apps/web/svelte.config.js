import adapter from '@sveltejs/adapter-static';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

/**
 * A pure SPA: no SSR runtime in the deployed artifact.
 *
 * The console is an operator tool behind a bridge that already terminates TLS
 * and serves the built files; adding a Node render tier would mean a second
 * process to run, secure and reason about for pages that are all live data
 * anyway — there is nothing to render on a server that would still be true by
 * the time it reached the browser.
 */
/** @type {import('@sveltejs/kit').Config} */
export default {
  preprocess: vitePreprocess(),
  kit: {
    adapter: adapter({
      pages: 'build',
      assets: 'build',
      fallback: 'index.html',
      precompress: false,
      strict: true,
    }),
  },
};
