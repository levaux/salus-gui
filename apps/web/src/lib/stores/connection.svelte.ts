/**
 * connection — is the path to the fleet alive, and which fleet is it?
 *
 * The probe is a real RPC (`Admin.Ping` against Network) rather than a fetch of
 * the bridge's own health: the bridge can be perfectly healthy while the fleet
 * behind it is unreachable, and a green light in that state is worse than none.
 *
 * On recovery the ConnectionManager mass-reconnects every registered stream, so
 * a bridge restart is a blip rather than a session an operator has to reload
 * out of.
 */
import { ConnectionManager, type BridgeHealth } from '@salus-gui/streams';
import { applyTheme, type Environment } from '@salus-gui/theme';
import { adminClient, adminTarget } from '../clients.js';
import { fetchBridgeInfo, type BridgeInfo } from '../transport.js';

export class ConnectionStore {
  health = $state<BridgeHealth>('up');
  info = $state<BridgeInfo | undefined>(undefined);
  infoError = $state<string | undefined>(undefined);

  readonly manager = new ConnectionManager({
    probe: async () => {
      try {
        // Network's own Admin surface: reachable only if the bridge AND the
        // fleet behind it are both up.
        await adminClient.ping(
          {},
          {
            ...adminTarget('127.0.0.1:57000'),
            signal: AbortSignal.timeout(3000),
          },
        );
        return true;
      } catch {
        return false;
      }
    },
    pollIntervalMs: 5000,
    onHealthChange: (h) => {
      this.health = h;
    },
  });

  async start(): Promise<void> {
    this.manager.start();
    await this.loadInfo();
  }

  stop(): void {
    this.manager.stop();
  }

  /**
   * Read which fleet the bridge is pointed at, and paint the environment band.
   *
   * If it cannot be read, the band stays at its default — which is the
   * production treatment. An environment the console cannot identify must not
   * be made to look safe.
   */
  async loadInfo(): Promise<void> {
    try {
      const info = await fetchBridgeInfo();
      this.info = info;
      this.infoError = undefined;
      applyTheme({ env: info.env as Environment });
    } catch (err) {
      this.infoError = err instanceof Error ? err.message : String(err);
    }
  }
}

export const connection = new ConnectionStore();
