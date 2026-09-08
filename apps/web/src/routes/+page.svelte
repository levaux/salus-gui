<script lang="ts">
  import { onMount } from 'svelte';
  import {
    DataGrid,
    LogView,
    StatusDot,
    StreamBadge,
    UNKNOWN,
    count,
    duration,
  } from '@salus-gui/ui-kit';
  import { acquireStore } from '@salus-gui/streams';
  import Topology from '$lib/panels/Topology.svelte';
  import Inspector from '$lib/panels/Inspector.svelte';
  import TelemetryTable from '$lib/panels/TelemetryTable.svelte';
  import { fleet, type ServiceRow } from '$lib/stores/fleet.svelte.js';
  import { logs } from '$lib/stores/logs.svelte.js';
  import { lifecycle } from '$lib/stores/lifecycle.svelte.js';
  import { telemetry } from '$lib/stores/telemetry.svelte.js';
  import { connection } from '$lib/stores/connection.svelte.js';

  /**
   * Fleet — Insights over the Monitor workbench.
   *
   * Four feeds, each reporting its own health because they degrade
   * independently: the registry poll, the aggregated log stream, the lifecycle
   * stream and the telemetry snapshot. One global "connected" light would hide
   * that logs are fine while the snapshot has been stale for a minute.
   *
   * All four are acquired through the store registry, so navigating away and
   * back inside the linger window reuses live feeds instead of re-subscribing.
   */
  onMount(() => {
    const release = [
      acquireStore(
        'fleet',
        () => fleet.start(),
        () => fleet.stop(),
      ),
      acquireStore(
        'logs',
        () => logs.start(),
        () => void logs.stop(),
      ),
      acquireStore(
        'lifecycle',
        () => lifecycle.start(),
        () => void lifecycle.stop(),
      ),
      acquireStore(
        'telemetry',
        () => telemetry.start(),
        () => void telemetry.stop(),
      ),
    ];
    return () => release.forEach((r) => r());
  });

  type Tab = 'registry' | 'telemetry' | 'logs' | 'lifecycle';
  let tab = $state<Tab>('registry');
  let selected = $state<string | undefined>(undefined);

  // Before the bridge's /bridge/info answers, read-only is unknown. Treat that
  // as NOT read-only rather than disabling every control: a console that greys
  // its buttons while it works out what it is looks broken, and the bridge is
  // the thing that actually refuses a mutator either way.
  const readOnly = $derived(connection.info?.readOnly === true);
  const degraded = $derived(fleet.rows.filter((r) => r.status !== 2).length);

  const registryColumns = [
    { key: 'name', header: 'Service' },
    { key: 'status', header: 'Status', width: '9rem' },
    { key: 'port', header: 'Port', numeric: true, width: '6rem' },
    { key: 'uptime', header: 'Uptime', numeric: true, width: '8rem' },
    { key: 'rpcs', header: 'RPCs', numeric: true, width: '9rem' },
    { key: 'active', header: 'Active', numeric: true, width: '6rem' },
    { key: 'fails', header: 'Fails', numeric: true, width: '5rem' },
  ];

  const LEVELS = [
    { value: 1, label: 'trace' },
    { value: 2, label: 'debug' },
    { value: 3, label: 'info' },
    { value: 4, label: 'warn' },
    { value: 6, label: 'error' },
  ];

  const TABS: { id: Tab; label: string }[] = [
    { id: 'registry', label: 'Registry' },
    { id: 'telemetry', label: 'SuiteSnapshot' },
    { id: 'logs', label: 'Logs' },
    { id: 'lifecycle', label: 'Lifecycle' },
  ];

  function badgeFor(id: Tab): string {
    if (id === 'registry') return `${fleet.rows.length}`;
    if (id === 'telemetry') return `${telemetry.rows.length}`;
    if (id === 'logs') return `${logs.rows.length}`;
    return `${lifecycle.rows.length}`;
  }
</script>

<div class="console">
  <!-- Insights: the schematic and the drawer. -->
  <section class="insights">
    <div class="topo">
      <div class="pane-head">
        <span class="pane-title">─── Insights · Topology ───</span>
        <span class="hint">
          {selected ? `${selected} selected · Inspector →` : 'click a node → Inspector'}
        </span>
      </div>
      <div class="topo-body">
        <Topology
          rows={fleet.rows}
          telemetry={telemetry.byComponent}
          sparksFor={(c) => telemetry.sparksFor(c)}
          {selected}
          onselect={(n) => (selected = n)}
        />
      </div>
    </div>

    <div class="inspect">
      <div class="pane-head">
        <span class="pane-title">─── Inspector ───</span>
      </div>
      <Inspector
        service={selected}
        rows={fleet.rows}
        telemetry={telemetry.byComponent}
        {readOnly}
        onclose={() => (selected = undefined)}
      />
    </div>
  </section>

  <!-- Workbench: the Monitor tab. -->
  <section class="workbench">
    <div class="tabbar">
      {#each TABS as t (t.id)}
        <button class="tab" class:on={tab === t.id} onclick={() => (tab = t.id)}>
          {t.label}<span class="badge">{badgeFor(t.id)}</span>
        </button>
      {/each}
      <span class="spacer"></span>
      {#if tab === 'logs'}
        <select
          class="level"
          value={logs.minLevel}
          onchange={(e) => logs.setMinLevel(Number(e.currentTarget.value))}
        >
          {#each LEVELS as l (l.value)}
            <option value={l.value}>≥ {l.label}</option>
          {/each}
        </select>
        <StreamBadge
          status={logs.stream.status}
          attempt={logs.stream.attempt}
          error={logs.stream.lastError}
        />
      {:else if tab === 'lifecycle'}
        <StreamBadge
          status={lifecycle.stream.status}
          attempt={lifecycle.stream.attempt}
          error={lifecycle.stream.lastError}
        />
      {:else if tab === 'telemetry'}
        <StreamBadge
          status={telemetry.stream.status}
          attempt={telemetry.stream.attempt}
          error={telemetry.stream.lastError}
        />
      {:else}
        <span class="meta">
          {#if fleet.error}
            <span class="bad">registry unreachable</span>
          {:else if fleet.lastUpdated}
            {fleet.rows.length} registered{degraded > 0 ? `, ${degraded} not running` : ''}
          {:else}
            loading…
          {/if}
        </span>
      {/if}
    </div>

    <div class="panel-body">
      {#if tab === 'registry'}
        <DataGrid
          columns={registryColumns}
          rows={fleet.rows}
          rowKey={(r: ServiceRow) => r.name}
          selected={selected ?? undefined}
          onselect={(r: ServiceRow) => (selected = r.name)}
          empty={fleet.error ? 'Registry unreachable' : 'No services registered'}
        >
          {#snippet children(row: ServiceRow, col: { key: string })}
            {#if col.key === 'name'}
              <span class="svc">{row.name}</span>
              <span class="addr">{row.adminAddress}</span>
            {:else if col.key === 'status'}
              <StatusDot status={row.status} />
            {:else if col.key === 'port'}
              {row.listenPort ?? UNKNOWN}
            {:else if col.key === 'uptime'}
              {duration(row.uptimeSeconds)}
            {:else if col.key === 'rpcs'}
              {count(row.rpcCount)}
            {:else if col.key === 'active'}
              {count(row.rpcActive)}
            {:else if col.key === 'fails'}
              <span class:bad={row.failCount > 0}>{row.failCount}</span>
            {/if}
          {/snippet}
        </DataGrid>
      {:else if tab === 'telemetry'}
        <TelemetryTable
          rows={telemetry.rows}
          focus={telemetry.focus}
          lastFrameAt={telemetry.lastFrameAt}
          onfocus={(c) => telemetry.setFocus(c)}
        />
      {:else if tab === 'logs'}
        <LogView rows={logs.rows} showService />
      {:else}
        <ul class="lifecycle">
          {#each lifecycle.latest(200) as e (e.seq)}
            <li>
              <span class="ev-type" data-type={e.eventType}>● {e.eventType}</span>
              <span class="ev-svc">{e.serviceName}</span>
              <span class="ev-msg">{e.message}</span>
            </li>
          {:else}
            <li class="empty">No lifecycle events yet — the feed reports them as they happen.</li>
          {/each}
        </ul>
      {/if}
    </div>
  </section>
</div>

<style>
  .console {
    display: grid;
    grid-template-rows: minmax(200px, 46%) minmax(200px, 1fr);
    gap: var(--sp-2);
    height: 100%;
    min-height: 0;
  }
  .insights {
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(300px, 27%);
    gap: var(--sp-2);
    min-height: 0;
  }
  .topo,
  .inspect,
  .workbench {
    display: flex;
    flex-direction: column;
    min-height: 0;
    background: var(--bg-surface);
    border: var(--border-w) solid var(--border-default);
    border-radius: var(--radius-md);
    overflow: hidden;
  }
  .topo-body {
    flex: 1;
    min-height: 0;
  }
  .pane-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--sp-2);
    padding: var(--sp-1) var(--sp-2);
    border-bottom: var(--border-w) solid var(--border-subtle);
  }
  .pane-title,
  .hint,
  .meta {
    font-family: var(--font-mono);
    font-size: var(--fs-xs);
    color: var(--fg-subtle);
  }

  .tabbar {
    display: flex;
    align-items: center;
    gap: var(--sp-1);
    padding: var(--sp-1) var(--sp-2);
    border-bottom: var(--border-w) solid var(--border-subtle);
  }
  .tab {
    display: inline-flex;
    align-items: center;
    gap: var(--sp-2);
    padding: 3px var(--sp-3);
    font-family: var(--font-mono);
    font-size: var(--fs-xs);
    background: transparent;
    border: none;
    border-radius: var(--radius-sm);
    color: var(--fg-muted);
    cursor: pointer;
  }
  .tab.on {
    background: var(--bg-raised);
    color: var(--fg-default);
  }
  .badge {
    font-size: 9px;
    color: var(--fg-subtle);
  }
  .spacer {
    flex: 1;
  }
  .level {
    font: var(--fs-xs) var(--font-ui);
    padding: 2px var(--sp-2);
    background: var(--bg-raised);
    border: var(--border-w) solid var(--border-default);
    border-radius: var(--radius-sm);
    color: var(--fg-muted);
  }
  .panel-body {
    flex: 1;
    min-height: 0;
    overflow: auto;
  }

  .svc {
    font-weight: var(--fw-medium);
  }
  .addr {
    display: block;
    font-family: var(--font-mono);
    font-size: var(--fs-xs);
    color: var(--fg-subtle);
  }
  .bad {
    color: var(--status-error);
    font-weight: var(--fw-medium);
  }

  .lifecycle {
    margin: 0;
    padding: var(--sp-2);
    list-style: none;
    font-family: var(--font-mono);
    font-size: var(--fs-xs);
  }
  .lifecycle li {
    display: flex;
    gap: var(--sp-3);
    padding: 1px 0;
  }
  .ev-type {
    flex: 0 0 7rem;
    color: var(--fg-subtle);
  }
  .ev-type[data-type='started'] {
    color: var(--status-running);
  }
  .ev-type[data-type='error'] {
    color: var(--status-error);
  }
  .ev-type[data-type='reconnected'] {
    color: var(--status-starting);
  }
  .ev-svc {
    flex: 0 0 9rem;
    color: var(--fg-default);
  }
  .ev-msg {
    min-width: 0;
    color: var(--fg-muted);
  }
  .empty {
    color: var(--fg-subtle);
  }
</style>
