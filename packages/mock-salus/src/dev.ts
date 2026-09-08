/**
 * dev — `pnpm dev:mock`.
 *
 * Starts the hub and stays up. `MOCK_PORT` and `MOCK_SEED` override the
 * defaults; the seed is echoed because a reproducible fleet is only useful if
 * you know which one you are looking at.
 */
import { MOCK_HUB_PORT, startMockServer } from './server.js';

const port = Number(process.env.MOCK_PORT ?? MOCK_HUB_PORT);
const seed = process.env.MOCK_SEED ?? 'salus-mock';

const running = await startMockServer({ port, seed });
console.log(`mock-salus listening on h2c :${running.port} (seed "${seed}")`);
console.log(
  `  services: ${running.fleet
    .listServices()
    .map((s) => s.name)
    .join(', ')}`,
);

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    void running.close().then(() => process.exit(0));
  });
}
