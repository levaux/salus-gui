<script lang="ts">
  import { onMount } from 'svelte';
  import {
    DataGrid,
    LogView,
    Panel,
    StatusDot,
    StreamBadge,
    UNKNOWN,
    count,
    duration,
  } from '@salus-gui/ui-kit';
  import { acquireStore } from '@salus-gui/streams';
  import { fleet, type ServiceRow } from '$lib/stores/fleet.svelte.js';
  import { logs } from '$lib/stores/logs.svelte.js';

  /**
   * The proving panel: fleet status and the aggregated log feed.
   *
   * Between them these exercise the whole path — browser → bridge → fleet —
   * plus both reconnect contracts the console depends on: the registry
   * re-reads and reconciles (Resnapshot), and the log feed resumes by sequence
   * (SeqResume). Acquired through the store registry, so navigating away and
   * back inside the linger window reuses the live feed instead of
   * re-snapshotting (Linger).
   */
  onMount(() => {
    const releaseFleet = acquireStore(
      'fleet',
      () => fleet.start(),
      () => fleet.stop(),
    );
    const releaseLogs = acquireStore(
      'logs',
      () => logs.start(),
      () => void logs.stop(),
    );
    return () => {
      releaseFleet();
      releaseLogs();
    };
  });

  const columns = [
    { key: 'name', header: 'Service' },
    { key: 'status', header: 'Status', width: '9rem' },
    { key: 'port', header: 'Port', numeric: true, width: '6rem' },
    { key: 'uptime', header: 'Uptime', numeric: true, width: '8rem' },
    { key: 'rpcs', header: 'RPCs', numeric: true, width: '9rem' },
    { key: 'active', header: 'Active', numeric: true, width: '6rem' },
    { key: 'queue', header: 'Queue', numeric: true, width: '6rem' },
    { key: 'fails', header: 'Fails', numeric: true, width: '5rem' },
  ];

  const LEVELS = [
    { value: 1, label: 'trace' },
    { value: 2, label: 'debug' },
    { value: 3, label: 'info' },
    { value: 4, label: 'warn' },
    { value: 6, label: 'error' },
  ];

  const degraded = $derived(fleet.rows.filter((r) => r.status !== 2).length);
</script>

<div class="page">
  <Panel
    title="Fleet"
    subtitle={fleet.lastUpdated
      ? `${fleet.rows.length} registered${degraded > 0 ? `, ${degraded} not running` : ''}`
      : 'loading…'}
  >
    {#snippet actions()}
      {#if fleet.error}
        <span class="err" title={fleet.error}>registry unreachable</span>
      {:else if fleet.lastUpdated}
        <span class="dim">updated {new Date(fleet.lastUpdated).toLocaleTimeString()}</span>
      {/if}
    {/snippet}

    <DataGrid
      {columns}
      rows={fleet.rows}
      rowKey={(r: ServiceRow) => r.name}
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
        {:else if col.key === 'queue'}
          {count(row.queueDepth)}
        {:else if col.key === 'fails'}
          <span class:bad={row.failCount > 0}>{row.failCount}</span>
        {/if}
      {/snippet}
    </DataGrid>
  </Panel>

  <Panel title="Fleet log" subtitle="Network.StreamLogs — resumes by seq on reconnect">
    {#snippet actions()}
      <select
        class="level"
        value={logs.minLevel}
        onchange={(e) => logs.setMinLevel(Number(e.currentTarget.value))}
      >
        {#each LEVELS as l (l.value)}
          <option value={l.value}>≥ {l.label}</option>
        {/each}
      </select>
      <span class="dim">{logs.rows.length} lines</span>
      <StreamBadge
        status={logs.stream.status}
        attempt={logs.stream.attempt}
        error={logs.stream.lastError}
      />
    {/snippet}

    <div class="logbody">
      <LogView rows={logs.rows} showService />
    </div>
  </Panel>
</div>

<style>
  .page {
    display: grid;
    grid-template-rows: auto minmax(320px, 1fr);
    gap: var(--sp-5);
    height: 100%;
    min-height: 0;
  }
  .logbody {
    height: 100%;
    min-height: 280px;
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
  .dim {
    font-size: var(--fs-xs);
    color: var(--fg-subtle);
  }
  .err {
    font-size: var(--fs-xs);
    color: var(--status-error);
  }
  .bad {
    color: var(--status-error);
    font-weight: var(--fw-medium);
  }
  .level {
    font: var(--fs-xs) var(--font-ui);
    padding: 2px var(--sp-2);
    border-radius: var(--radius-sm);
    border: var(--border-w) solid var(--border-default);
    background: var(--bg-raised);
    color: var(--fg-muted);
  }
</style>
