<script lang="ts">
  import { untrack } from 'svelte';
  import {
    LogView,
    StatusDot,
    StreamBadge,
    UNKNOWN,
    count,
    duration,
    statusName,
  } from '@salus-gui/ui-kit';
  import { admin } from '../stores/admin.svelte.js';
  import { lifecycle } from '../stores/lifecycle.svelte.js';
  import { serviceLogs } from '../stores/service-logs.svelte.js';
  import type { ServiceRow } from '../stores/fleet.svelte.js';
  import type { ComponentTelemetry } from '../stores/telemetry.svelte.js';

  /**
   * Inspector — one node in full, and the only place the console mutates.
   *
   * Destructive actions arm before they fire. Not a confirmation dialog: an
   * armed button states what it is about to do in place, and a second click
   * commits. A modal trains an operator to dismiss modals; an armed button
   * makes the dangerous state visible where the danger is.
   *
   * Nothing here enforces read-only. The bridge refuses the RPC fleet-wide, and
   * this renders the refusal — a client that greyed its own buttons and stopped
   * there would be enforcing policy in the one place it can be bypassed.
   */
  interface Props {
    service: string | undefined;
    rows: ServiceRow[];
    telemetry: Map<string, ComponentTelemetry>;
    readOnly: boolean;
    onclose: () => void;
  }

  const { service, rows, telemetry, readOnly, onclose }: Props = $props();

  /** Which destructive action is armed, if any. Cleared on every selection change. */
  let armed = $state<string | undefined>(undefined);

  const row = $derived(rows.find((r) => r.name === service));
  const tele = $derived(service ? telemetry.get(service) : undefined);
  const facts = $derived(admin.facts);
  const target = $derived(
    service !== undefined && row !== undefined
      ? { name: service, address: row.adminAddress }
      : undefined,
  );
  const events = $derived(service ? lifecycle.forService(service).slice(0, 8) : []);

  // Load on selection change, and disarm: an armed Shutdown must not survive
  // the operator moving to a different service.
  //
  // Tracks `service` ONLY. The address is read untracked because `rows` is
  // replaced on every registry poll, so tracking it would re-issue the whole
  // drawer load every few seconds — three RPCs per service per poll, and a
  // drawer that flickers back to its loading state while an operator reads it.
  $effect(() => {
    const svc = service;
    armed = undefined;
    if (svc === undefined) {
      admin.clear();
      void serviceLogs.follow(undefined);
      return;
    }
    const address = untrack(() => rows.find((r) => r.name === svc)?.adminAddress ?? '');
    void admin.load(svc, address);
    // The service's own log, straight from its Admin — readable even when the
    // aggregator is the thing that is down.
    void serviceLogs.follow(address);
  });

  function fire(name: string, run: () => Promise<void>): void {
    if (armed === name) {
      armed = undefined;
      void run();
    } else {
      armed = name;
    }
  }

  const traceOn = $derived(facts?.config?.['trace_enabled'] === true);
  const debugOn = $derived(facts?.config?.['debug_enabled'] === true);
</script>

<div class="inspector">
  {#if service === undefined}
    <div class="head">
      <span class="title">Salus platform</span>
      <span class="sub">localhost · operator plane</span>
    </div>
    <p class="blurb">
      Select a node to inspect it. The fleet is reached directly over h2c — the private Admin,
      registry and query surfaces are deliberately not routed through the Envoy edge.
    </p>
    <dl class="facts">
      <dt>services</dt>
      <dd>{rows.length} registered</dd>
      <dt>running</dt>
      <dd>{rows.filter((r) => r.status === 2).length}</dd>
      <dt>not running</dt>
      <dd class:bad={rows.some((r) => r.status !== 2)}>
        {rows.filter((r) => r.status !== 2).length}
      </dd>
    </dl>
  {:else}
    <div class="head">
      <button class="back" onclick={onclose} aria-label="Back to overview">←</button>
      <StatusDot status={row?.status ?? 0} />
      <span class="title">{service}</span>
      <span class="sub">{row?.adminAddress ?? UNKNOWN}</span>
    </div>

    {#if admin.error}
      <p class="err">Admin unreachable — {admin.error}</p>
    {/if}

    <dl class="facts">
      <dt>status</dt>
      <dd>{statusName(row?.status)}</dd>
      <dt>uptime</dt>
      <dd>{duration(facts?.uptimeSeconds ?? row?.uptimeSeconds)}</dd>
      <dt>listen</dt>
      <dd class="mono data">{facts ? `${facts.listenAddress}:${facts.listenPort}` : UNKNOWN}</dd>
      <dt>rpcs</dt>
      <dd>{count(facts?.rpcCount)}</dd>
      <dt>in flight</dt>
      <dd>{count(facts?.rpcActive)}</dd>
      <dt>queue</dt>
      <dd>{count(facts?.queueDepth)}</dd>
      <dt>threads</dt>
      <dd>{count(facts?.threadPoolSize)}</dd>
      <dt>fail count</dt>
      <dd class:bad={(row?.failCount ?? 0) > 0}>{count(row?.failCount)}</dd>
      <dt>denied</dt>
      <dd class:bad={(tele?.denied ?? 0n) > 0n}>{count(tele?.denied)}</dd>
      <dt>trace</dt>
      <dd>{facts?.config === undefined ? UNKNOWN : traceOn ? 'on' : 'off'}</dd>
      <dt>debug</dt>
      <dd>{facts?.config === undefined ? UNKNOWN : debugOn ? 'on' : 'off'}</dd>
    </dl>

    <div class="actions">
      <button
        class="act"
        disabled={readOnly}
        title={readOnly ? 'read-only mode' : 'Toggle trace logging'}
        onclick={() => target && void admin.setTrace(target, !traceOn)}
      >
        ⟳ Trace {traceOn ? 'off' : 'on'}
      </button>
      <button
        class="act"
        disabled={readOnly}
        title={readOnly ? 'read-only mode' : 'Toggle debug logging'}
        onclick={() => target && void admin.setDebug(target, !debugOn)}
      >
        ⟳ Debug {debugOn ? 'off' : 'on'}
      </button>
      <button
        class="act warn"
        class:armed={armed === 'drain'}
        disabled={readOnly}
        title={readOnly ? 'read-only mode' : 'Stop accepting new RPCs'}
        onclick={() => target && fire('drain', () => admin.drain(target))}
      >
        {armed === 'drain' ? '◐ Confirm drain' : '◐ Drain'}
      </button>
      <button
        class="act bad"
        class:armed={armed === 'shutdown'}
        disabled={readOnly}
        title={readOnly ? 'read-only mode' : 'Stop the process'}
        onclick={() => target && fire('shutdown', () => admin.shutdown(target))}
      >
        {armed === 'shutdown' ? '■ Confirm shutdown' : '■ Shutdown'}
      </button>
      <button
        class="act"
        disabled={readOnly}
        title={readOnly ? 'read-only mode' : 'Clear this component’s telemetry counters'}
        onclick={() => void admin.resetTelemetry(service)}
      >
        ⟲ Reset telemetry
      </button>
    </div>

    {#if admin.lastAction}
      <p class="result" class:bad={!admin.lastAction.ok}>
        {admin.lastAction.action}: {admin.lastAction.detail}
      </p>
    {/if}

    <div class="section">─── Events ───</div>
    {#if events.length === 0}
      <p class="empty">No lifecycle events seen for this service yet.</p>
    {:else}
      <ul class="events">
        {#each events as e (e.seq)}
          <li>
            <span class="ev-type" data-type={e.eventType}>● {e.eventType}</span>
            <span class="ev-msg">{e.message}</span>
          </li>
        {/each}
      </ul>
    {/if}

    <div class="section">
      ─── Logs ───
      <StreamBadge
        status={serviceLogs.stream.status}
        attempt={serviceLogs.stream.attempt}
        error={serviceLogs.stream.lastError}
      />
    </div>
    <div class="logbox">
      <LogView rows={serviceLogs.rows} />
    </div>
  {/if}
</div>

<style>
  .inspector {
    height: 100%;
    min-height: 0;
    padding: var(--sp-3);
    overflow-y: auto;
    font-size: var(--fs-sm);
  }
  .head {
    display: flex;
    align-items: center;
    gap: var(--sp-2);
    margin-bottom: var(--sp-2);
  }
  .back {
    padding: 0 var(--sp-2);
    background: none;
    border: var(--border-w) solid var(--border-default);
    border-radius: var(--radius-sm);
    color: var(--fg-muted);
    cursor: pointer;
  }
  .title {
    font-family: var(--font-ui);
    font-size: var(--fs-lg);
    font-weight: var(--fw-bold);
    color: var(--fg-default);
  }
  .sub {
    font-family: var(--font-mono);
    font-size: var(--fs-xs);
    color: var(--fg-subtle);
  }
  .blurb,
  .empty {
    margin: 0 0 var(--sp-3);
    font-family: var(--font-mono);
    font-size: var(--fs-xs);
    line-height: 1.5;
    color: var(--fg-muted);
  }

  .facts {
    display: grid;
    grid-template-columns: auto minmax(0, 1fr);
    gap: 2px var(--sp-4);
    margin: 0 0 var(--sp-3);
    font-family: var(--font-mono);
    font-size: var(--fs-sm);
  }
  dt {
    color: var(--fg-subtle);
  }
  dd {
    margin: 0;
    color: var(--fg-default);
    font-variant-numeric: var(--num-variant);
  }
  dd.bad {
    color: var(--status-error);
  }
  .mono {
    font-family: var(--font-mono);
  }
  .data {
    color: var(--accent-data);
  }

  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: var(--sp-1);
    margin-bottom: var(--sp-2);
  }
  .act {
    padding: 3px var(--sp-2);
    font-family: var(--font-mono);
    font-size: var(--fs-xs);
    font-weight: var(--fw-medium);
    background: var(--bg-raised);
    border: var(--border-w) solid var(--border-default);
    border-radius: var(--radius-sm);
    color: var(--fg-muted);
    cursor: pointer;
  }
  .act:hover:not(:disabled) {
    border-color: var(--border-strong);
    color: var(--fg-default);
  }
  .act:disabled {
    opacity: 0.45;
    cursor: not-allowed;
  }
  .act.warn {
    color: var(--status-degraded);
  }
  .act.bad {
    color: var(--status-error);
  }
  /* An armed button announces itself where the danger is, rather than in a
     modal an operator learns to dismiss without reading. */
  .act.armed {
    background: color-mix(in srgb, var(--status-error) 10%, transparent);
    border-color: var(--status-error);
    color: var(--status-error);
  }

  .result {
    margin: 0 0 var(--sp-3);
    font-family: var(--font-mono);
    font-size: var(--fs-xs);
    color: var(--status-running);
  }
  .result.bad,
  .err {
    color: var(--status-error);
  }
  .err {
    margin: 0 0 var(--sp-2);
    font-family: var(--font-mono);
    font-size: var(--fs-xs);
  }

  .section {
    display: flex;
    align-items: center;
    gap: var(--sp-2);
    margin: var(--sp-3) 0 var(--sp-2);
    font-family: var(--font-mono);
    font-size: var(--fs-xs);
    color: var(--fg-subtle);
  }
  .logbox {
    height: 180px;
    border: var(--border-w) solid var(--border-subtle);
    border-radius: var(--radius-sm);
    overflow: hidden;
  }
  .events {
    margin: 0;
    padding: 0;
    list-style: none;
    font-family: var(--font-mono);
    font-size: var(--fs-xs);
  }
  .events li {
    display: flex;
    gap: var(--sp-2);
    padding: 1px 0;
  }
  .ev-type {
    flex: 0 0 auto;
    color: var(--fg-subtle);
  }
  .ev-type[data-type='started'] {
    color: var(--status-running);
  }
  .ev-type[data-type='stopped'] {
    color: var(--fg-subtle);
  }
  .ev-type[data-type='error'] {
    color: var(--status-error);
  }
  .ev-type[data-type='reconnected'] {
    color: var(--status-starting);
  }
  .ev-msg {
    min-width: 0;
    overflow: hidden;
    color: var(--fg-muted);
    text-overflow: ellipsis;
    white-space: nowrap;
  }
</style>
