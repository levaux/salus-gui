/**
 * admin — the per-service Admin drawer: facts, config, and the mutators.
 *
 * Every call carries `salus-admin-target`, because `Salus.Admin.Admin` is
 * registered on every Component and a call has to say which one it means. The
 * bridge resolves that to an address, dials it, and strips the header.
 *
 * **Mutators are not guarded here.** The read-only switch lives in the bridge
 * and refuses the RPC fleet-wide; this store surfaces the refusal. A client
 * that disabled its own buttons and stopped there would be enforcing policy in
 * the one place an operator can bypass with devtools.
 */
import { adminClient, adminTarget, networkClient } from '../clients.js';

export interface AdminFacts {
  serviceName: string;
  status: number;
  uptimeSeconds: bigint;
  listenAddress: string;
  listenPort: number;
  threadPoolSize?: number;
  activeChannels?: number;
  rpcCount?: bigint;
  rpcActive?: number;
  queueDepth?: number;
  /** Parsed from GetConfig's `{ format, payload }` blob. */
  config?: Record<string, unknown>;
  configFormat?: string;
}

/**
 * A service and the address to dial it on.
 *
 * Both, always: `salus-admin-target` is a `host:port` the bridge resolves and
 * pins, and it rejects a bare service name outright. Carrying the pair in one
 * value stops a caller reaching for the name — which reads perfectly and fails
 * only against a running bridge.
 */
export interface AdminTargetRef {
  readonly name: string;
  readonly address: string;
}

/** What the last mutator did, so the drawer can report it rather than guess. */
export interface ActionResult {
  action: string;
  ok: boolean;
  detail: string;
  at: number;
}

export class AdminStore {
  facts = $state<AdminFacts | undefined>(undefined);
  loading = $state(false);
  error = $state<string | undefined>(undefined);
  lastAction = $state<ActionResult | undefined>(undefined);
  /** Which service the held facts belong to — the supersede guard's key. */
  private inFlightFor: string | undefined;

  /**
   * Load one service's drawer.
   *
   * Guarded against supersede: a slow response for service A landing after the
   * operator has clicked B must not render A's numbers under B's heading. The
   * response is dropped unless it is still the selected service.
   */
  async load(service: string, address: string): Promise<void> {
    this.inFlightFor = service;
    this.loading = true;
    this.error = undefined;
    // Dial by ADDRESS. `salus-admin-target` is a host:port the bridge resolves
    // and pins to the site host or loopback; a service NAME is rejected as an
    // invalid target. The name is only the supersede key.
    const opts = adminTarget(address);
    try {
      const [status, metrics, config] = await Promise.allSettled([
        adminClient.getStatus({}, opts),
        adminClient.getMetrics({}, opts),
        // The console always asks for redaction. The service decides what that
        // means; the console never renders a secret it was handed.
        adminClient.getConfig({ redactSecrets: true }, opts),
      ]);

      if (this.inFlightFor !== service) return; // superseded

      if (status.status === 'rejected') {
        this.error = status.reason instanceof Error ? status.reason.message : String(status.reason);
        this.facts = undefined;
        return;
      }

      const facts: AdminFacts = {
        serviceName: status.value.serviceName,
        status: status.value.status,
        uptimeSeconds: status.value.uptimeSeconds,
        listenAddress: status.value.listenAddress,
        listenPort: status.value.listenPort,
      };
      if (metrics.status === 'fulfilled') {
        facts.threadPoolSize = metrics.value.threadPoolSize;
        facts.activeChannels = metrics.value.activeChannels;
        facts.rpcCount = metrics.value.rpcCount;
        facts.rpcActive = metrics.value.rpcActive;
        facts.queueDepth = metrics.value.queueDepth;
      }
      if (config.status === 'fulfilled') {
        facts.configFormat = config.value.format;
        facts.config = parseConfig(config.value.format, config.value.payload);
      }
      this.facts = facts;
    } finally {
      if (this.inFlightFor === service) this.loading = false;
    }
  }

  clear(): void {
    this.inFlightFor = undefined;
    this.facts = undefined;
    this.error = undefined;
  }

  private async run(action: string, t: AdminTargetRef, call: () => Promise<string>): Promise<void> {
    try {
      const detail = await call();
      this.lastAction = { action, ok: true, detail, at: Date.now() };
    } catch (err) {
      // A refusal is a result, not a crash — read-only mode arrives here.
      this.lastAction = {
        action,
        ok: false,
        detail: err instanceof Error ? err.message : String(err),
        at: Date.now(),
      };
    }
    // Re-read rather than trusting what was painted from the response: the
    // effects of a drain or a flag land on the service, and the authority for
    // its state is the service.
    await this.load(t.name, t.address);
  }

  async setTrace(t: AdminTargetRef, enabled: boolean): Promise<void> {
    await this.run(`SetTrace ${enabled ? 'on' : 'off'}`, t, async () => {
      const res = await adminClient.setTrace({ enabled }, adminTarget(t.address));
      // SetLogLevelResponse carries only `enabled` — there is no `previous`
      // field, so the drawer reports the new state and nothing more.
      return `trace ${res.enabled ? 'enabled' : 'disabled'}`;
    });
  }

  async setDebug(t: AdminTargetRef, enabled: boolean): Promise<void> {
    await this.run(`SetDebug ${enabled ? 'on' : 'off'}`, t, async () => {
      const res = await adminClient.setDebug({ enabled }, adminTarget(t.address));
      return `debug ${res.enabled ? 'enabled' : 'disabled'}`;
    });
  }

  async drain(t: AdminTargetRef): Promise<void> {
    await this.run('Drain', t, async () => {
      const res = await adminClient.drain({}, adminTarget(t.address));
      return res.accepted ? `draining, ${res.inFlightRpcs} in flight` : `refused: ${res.detail}`;
    });
  }

  async shutdown(t: AdminTargetRef): Promise<void> {
    await this.run('Shutdown', t, async () => {
      const res = await adminClient.shutdown({}, adminTarget(t.address));
      return res.accepted ? res.message : `refused: ${res.message}`;
    });
  }

  /** `Network.Reset` — empty name clears every component's counters. */
  async resetTelemetry(component = ''): Promise<void> {
    const label = component === '' ? 'Reset (all)' : `Reset ${component}`;
    try {
      await networkClient.reset({ componentName: component });
      this.lastAction = { action: label, ok: true, detail: 'counters cleared', at: Date.now() };
    } catch (err) {
      this.lastAction = {
        action: label,
        ok: false,
        detail: err instanceof Error ? err.message : String(err),
        at: Date.now(),
      };
    }
  }
}

/**
 * `GetConfig` returns `{ format, payload }` — a serialized blob, not typed
 * fields. Parse by the declared format and fall back to showing the raw text
 * rather than guessing at a shape we were not given.
 */
function parseConfig(format: string, payload: string): Record<string, unknown> {
  if (format === 'json') {
    try {
      const parsed: unknown = JSON.parse(payload);
      if (parsed !== null && typeof parsed === 'object') return parsed as Record<string, unknown>;
    } catch {
      // fall through to the raw view
    }
  }
  return { [`${format || 'raw'} payload`]: payload };
}

export const admin = new AdminStore();
