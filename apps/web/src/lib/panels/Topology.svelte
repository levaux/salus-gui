<script lang="ts">
  import { ServiceChip, count, duration } from '@salus-gui/ui-kit';
  import type { ServiceRow } from '../stores/fleet.svelte.js';
  import type { ComponentTelemetry } from '../stores/telemetry.svelte.js';

  /**
   * Topology — the fleet as a schematic, not a graph.
   *
   * **Fixed positions, deliberately.** A force layout would move a service
   * every time the fleet changed, and an operator navigates this by muscle
   * memory: Session is always the middle of the route row. The platform's shape
   * is knowable and stable, so the diagram encodes it rather than discovering
   * it. Coordinates are viewBox units (1180×360), scaled to fit.
   *
   * The links carry state: a path is live only when both ends are up. That is
   * the one thing a table cannot show — that Authentication is fine but nothing
   * can reach it because the edge is down.
   */
  interface Props {
    rows: ServiceRow[];
    telemetry: Map<string, ComponentTelemetry>;
    sparksFor: (component: string) => { rpc: number[]; io: number[] };
    selected?: string | undefined;
    onselect: (name: string | undefined) => void;
  }

  const { rows, telemetry, sparksFor, selected, onselect }: Props = $props();

  const RUNNING = 2;
  const CHIP_H = 108;

  /** Fixed schematic positions, in viewBox units. */
  const NODES = [
    { name: 'Authentication', x: 346, y: 6, w: 194 },
    { name: 'Session', x: 556, y: 6, w: 194 },
    { name: 'Protocol', x: 766, y: 6, w: 194 },
    { name: 'Health', x: 346, y: 246, w: 194 },
    { name: 'Therapy', x: 556, y: 246, w: 194 },
    { name: 'Network', x: 976, y: 126, w: 194 },
  ] as const;

  const byName = $derived(new Map(rows.map((r) => [r.name, r])));

  /** A service is reachable only if the registry says it is connected and up. */
  const isUp = (name: string): boolean => {
    const r = byName.get(name);
    return r !== undefined && r.status === RUNNING && r.connected;
  };

  const sessionUp = $derived(isUp('Session'));
  const networkUp = $derived(isUp('Network'));

  /** Stroke treatment per link state — live, idle, or broken. */
  function linkClass(live: boolean, broken: boolean): string {
    return broken ? 'link broken' : live ? 'link live' : 'link idle';
  }

  function stats(name: string): { label: string; value: string; tone?: 'warn' | 'bad' }[] {
    const r = byName.get(name);
    const t = telemetry.get(name);
    if (!r) return [];
    const seen = r.connected ? 'live' : 'STALE';
    return [
      { label: 'uptime', value: duration(r.uptimeSeconds) },
      // `seen` degrades to STALE rather than showing a stale age as if fresh.
      { label: 'seen', value: seen, ...(r.connected ? {} : { tone: 'warn' as const }) },
      {
        label: 'inflt',
        value: count(r.rpcActive),
        ...((t?.denied ?? 0n) > 0n ? { tone: 'bad' as const } : {}),
      },
    ];
  }

  function sparks(name: string): {
    rpc: number[];
    io: number[];
    rpcLabel: string;
    ioLabel: string;
  } {
    const s = sparksFor(name);
    const t = telemetry.get(name);
    return {
      rpc: s.rpc,
      io: s.io,
      rpcLabel: t ? `${t.rpcPerSecond.toFixed(1)}/s` : '—',
      ioLabel: t ? formatBytes(t.bytesPerSecond) : '—',
    };
  }

  function formatBytes(bps: number): string {
    if (!Number.isFinite(bps) || bps <= 0) return '0 B/s';
    if (bps < 1024) return `${Math.round(bps)} B/s`;
    if (bps < 1024 * 1024) return `${(bps / 1024).toFixed(1)} KB/s`;
    return `${(bps / (1024 * 1024)).toFixed(1)} MB/s`;
  }
</script>

<div class="wrap">
  <svg
    viewBox="0 0 1180 360"
    preserveAspectRatio="xMidYMid meet"
    role="img"
    aria-label="Fleet topology"
  >
    <defs>
      <pattern id="grid" width="20" height="20" patternUnits="userSpaceOnUse">
        <path d="M20 0 H0 V20" fill="none" stroke="var(--border-subtle)" stroke-width="1" />
      </pattern>
    </defs>
    <rect width="1180" height="360" fill="url(#grid)" opacity="0.5" />

    <!-- Links render under the chips, so a chip never sits on a line. -->
    <g class="links">
      <!-- Edge fleet → Envoy, then the route bus every edge-routed call takes. -->
      <path d="M156 180 H172" class={linkClass(sessionUp, !sessionUp)} />
      <path d="M328 180 H880" class={linkClass(sessionUp, !sessionUp)} />
      {#each [{ x: 443, up: true }, { x: 653, up: true }, { x: 863, up: true }] as c (c.x)}
        <path d="M{c.x} 180 V114" class={linkClass(sessionUp, !sessionUp)} />
      {/each}
      {#each [{ x: 443 }, { x: 653 }] as c (c.x)}
        <path d="M{c.x} 180 V246" class={linkClass(sessionUp, !sessionUp)} />
      {/each}

      <!-- Telemetry: every Component pushes digests to Network. Dotted, because
           it is a different kind of traffic from a routed call. -->
      <path d="M880 180 H976" class={networkUp ? 'link telemetry live' : 'link telemetry broken'} />

      <!-- Store buses sit behind their rows; they are plain, not animated. -->
      <path d="M540 60 H976" class="bus" />
      <path d="M540 300 H766" class="bus" />
    </g>

    <text x="242" y="200" class="edge-label">Bearer JWT · h2c</text>
    <text x="604" y="200" class="bus-label">
      {sessionUp ? 'jwt_authn → ext_authz' : 'ext_authz DENY · Session down'}
    </text>
    <text x="928" y="172" class="bus-label" text-anchor="middle">
      {networkUp ? 'telemetry' : 'bus down'}
    </text>

    {#each NODES as n (n.name)}
      {@const row = byName.get(n.name)}
      <foreignObject x={n.x} y={n.y} width={n.w} height={CHIP_H}>
        <div class="chip-host">
          <ServiceChip
            name={n.name}
            status={row?.status}
            addr={row ? row.adminAddress : 'not registered'}
            stats={stats(n.name)}
            sparks={sparks(n.name)}
            selected={selected === n.name}
            live={row?.connected ?? false}
            onselect={() => onselect(selected === n.name ? undefined : n.name)}
          />
        </div>
      </foreignObject>
    {/each}
  </svg>
</div>

<style>
  .wrap {
    height: 100%;
    min-height: 0;
    padding: var(--sp-2);
    overflow: hidden;
  }
  svg {
    width: 100%;
    height: 100%;
  }
  .chip-host {
    width: 100%;
    height: 100%;
  }

  .links path {
    fill: none;
  }
  .link {
    stroke: var(--border-strong);
    stroke-width: 1.5;
    stroke-dasharray: 6 6;
  }
  .link.live {
    animation: flow 1s linear infinite;
  }
  .link.idle {
    stroke: var(--border-default);
    stroke-dasharray: 2 4;
  }
  .link.broken {
    stroke: var(--status-error);
    stroke-width: 1.2;
    stroke-dasharray: 2 4;
    animation: none;
  }
  .link.telemetry {
    stroke-width: 1;
    stroke-dasharray: 2 5;
    animation-duration: 1.6s;
  }
  .bus {
    stroke: var(--border-strong);
    stroke-width: 1.2;
  }
  @keyframes flow {
    to {
      stroke-dashoffset: -24;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .link.live {
      animation: none;
    }
  }

  .edge-label,
  .bus-label {
    font-family: var(--font-mono);
    font-size: 11px;
    fill: var(--fg-subtle);
    text-anchor: middle;
  }
</style>
