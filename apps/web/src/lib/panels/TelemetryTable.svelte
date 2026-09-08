<script lang="ts">
  import { DataGrid, UNKNOWN, count } from '@salus-gui/ui-kit';
  import type { TelemetryRow } from '../stores/telemetry.svelte.js';

  /**
   * SuiteSnapshot — Network's aggregated per-(component, method) RPC table.
   *
   * The meta line shows the snapshot's **age**, not a sequence number. This
   * feed has no seq: `SuiteSnapshot` carries `snapshot_at_us`, `components[]`
   * and `rows[]` and nothing else. The original design specified `seq 4,821`
   * here and in the footer; there is no such value to render, and inventing one
   * would be the console fabricating in its own chrome. Age answers the same
   * operator question — is what I am looking at current — from a field that
   * exists.
   */
  interface Props {
    rows: TelemetryRow[];
    focus: string | undefined;
    lastFrameAt: number | undefined;
    onfocus: (component: string | undefined) => void;
  }

  const { rows, focus, lastFrameAt, onfocus }: Props = $props();

  /** Ticks once a second so the age reads as live rather than frozen. */
  let now = $state(Date.now());
  $effect(() => {
    const t = setInterval(() => (now = Date.now()), 1000);
    return () => clearInterval(t);
  });

  const KIND_LABEL: Record<number, string> = { 1: 'U', 2: 'SS', 3: 'CS', 4: 'BB' };

  const shown = $derived(focus === undefined ? rows : rows.filter((r) => r.component === focus));
  const components = $derived([...new Set(rows.map((r) => r.component))].sort());

  const ageSeconds = $derived(
    lastFrameAt === undefined ? undefined : Math.max(0, Math.round((now - lastFrameAt) / 1000)),
  );
  /** A snapshot older than a few periods is stale — derived from the frame, not guessed. */
  const stale = $derived(ageSeconds !== undefined && ageSeconds > 5);

  const columns = [
    { key: 'method', header: 'Component · method' },
    { key: 'kind', header: 'Kind', width: '4rem' },
    { key: 'rate', header: 'msg/s', numeric: true, width: '5.5rem' },
    { key: 'io', header: 'B/s in+out', numeric: true, width: '7rem' },
    { key: 'p50', header: 'p50', numeric: true, width: '5rem' },
    { key: 'p95', header: 'p95', numeric: true, width: '5rem' },
    { key: 'p99', header: 'p99', numeric: true, width: '5rem' },
    { key: 'calls', header: 'Calls', numeric: true, width: '6rem' },
    { key: 'err', header: 'Err', numeric: true, width: '4.5rem' },
    { key: 'denied', header: 'Denied', numeric: true, width: '5rem' },
  ];

  const micros = (us: number): string => (us > 0 ? `${(us / 1000).toFixed(1)}ms` : UNKNOWN);
  const bytes = (bps: number): string =>
    bps < 1024 ? `${Math.round(bps)}` : `${(bps / 1024).toFixed(1)}k`;

  const errorsOf = (r: TelemetryRow): bigint => {
    const ok = r.statusCodeCounts[0] ?? 0n;
    return r.callsTotal > ok ? r.callsTotal - ok : 0n;
  };
  const deniedOf = (r: TelemetryRow): bigint => r.statusCodeCounts[7] ?? 0n;
</script>

<div class="panel">
  <div class="bar">
    <div class="chips">
      <button class="chip" class:on={focus === undefined} onclick={() => onfocus(undefined)}>
        all
      </button>
      {#each components as c (c)}
        <button class="chip" class:on={focus === c} onclick={() => onfocus(c)}>{c}</button>
      {/each}
    </div>
    <span class="meta" class:stale>
      {#if ageSeconds === undefined}
        awaiting first snapshot
      {:else}
        {stale ? '⊘' : '⟳'} updated {ageSeconds}s ago · {components.length} components · {shown.length}
        rows
      {/if}
    </span>
  </div>

  <div class="body">
    <DataGrid
      {columns}
      rows={shown}
      rowKey={(r: TelemetryRow) => `${r.component}/${r.name}`}
      empty="No telemetry reported"
    >
      {#snippet children(row: TelemetryRow, col: { key: string })}
        {#if col.key === 'method'}
          <span class="comp">{row.component}</span><span class="meth">·{row.name}</span>
        {:else if col.key === 'kind'}
          <span class="kind">{KIND_LABEL[row.kind] ?? '?'}</span>
        {:else if col.key === 'rate'}
          <!-- Blank, not 0.0: a unary RPC carries no messages, so a rate here
               would be a measurement that does not apply. -->
          {row.msgRate1s > 0 ? row.msgRate1s.toFixed(1) : UNKNOWN}
        {:else if col.key === 'io'}
          {bytes(row.bpsIn1s + row.bpsOut1s)}
        {:else if col.key === 'p50'}
          {micros(row.latencyP50Us)}
        {:else if col.key === 'p95'}
          {micros(row.latencyP95Us)}
        {:else if col.key === 'p99'}
          {micros(row.latencyP99Us)}
        {:else if col.key === 'calls'}
          {count(row.callsTotal)}
        {:else if col.key === 'err'}
          <span class:bad={errorsOf(row) > 0n}>{count(errorsOf(row))}</span>
        {:else if col.key === 'denied'}
          <span class:bad={deniedOf(row) > 0n}>{count(deniedOf(row))}</span>
        {/if}
      {/snippet}
    </DataGrid>
  </div>
</div>

<style>
  .panel {
    display: flex;
    flex-direction: column;
    height: 100%;
    min-height: 0;
  }
  .bar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--sp-3);
    padding: var(--sp-1) var(--sp-2);
    border-bottom: var(--border-w) solid var(--border-subtle);
  }
  .chips {
    display: flex;
    flex-wrap: wrap;
    gap: var(--sp-1);
  }
  .chip {
    padding: 1px var(--sp-2);
    font-family: var(--font-mono);
    font-size: var(--fs-xs);
    background: transparent;
    border: var(--border-w) solid transparent;
    border-radius: var(--radius-sm);
    color: var(--fg-subtle);
    cursor: pointer;
  }
  .chip.on {
    background: var(--bg-raised);
    border-color: var(--border-strong);
    color: var(--fg-default);
  }
  .meta {
    flex: 0 0 auto;
    font-family: var(--font-mono);
    font-size: var(--fs-xs);
    color: var(--fg-subtle);
  }
  .meta.stale {
    color: var(--status-degraded);
  }
  .body {
    flex: 1;
    min-height: 0;
    overflow: auto;
  }
  .comp {
    color: var(--fg-default);
  }
  .meth {
    color: var(--fg-subtle);
  }
  .kind {
    font-family: var(--font-mono);
    color: var(--accent-data);
  }
  .bad {
    color: var(--status-error);
  }
</style>
