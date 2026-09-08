<script lang="ts">
  import '../app.css';
  import { onMount } from 'svelte';
  import { page } from '$app/state';
  import { MODULES } from '$lib/modules.js';
  import { connection } from '$lib/stores/connection.svelte.js';
  import { setReadOnly } from '$lib/transport.js';

  const { children } = $props();

  let flipping = $state(false);

  onMount(() => {
    void connection.start();
    return () => connection.stop();
  });

  async function toggleReadOnly(): Promise<void> {
    if (!connection.info) return;
    flipping = true;
    try {
      const next = await setReadOnly(!connection.info.readOnly);
      connection.info = { ...connection.info, readOnly: next };
    } finally {
      flipping = false;
    }
  }
</script>

<div class="shell">
  <nav class="rail">
    <div class="brand" title="Salus operations console">S</div>
    {#each MODULES as m (m.id)}
      {#if m.enabled}
        <a href={m.route} class="item" class:active={page.url.pathname === m.route} title={m.title}>
          <span class="icon">{m.icon}</span>
          <span class="label">{m.title}</span>
        </a>
      {:else}
        <span class="item disabled" title={m.note ?? 'Not built yet'}>
          <span class="icon">{m.icon}</span>
          <span class="label">{m.title}</span>
        </span>
      {/if}
    {/each}
  </nav>

  <div class="main">
    <header class="topbar">
      <div class="env">
        {#if connection.info}
          <strong>{connection.info.name}</strong>
          <span class="dim">
            {connection.info.host}{connection.info.portBase ? `:${connection.info.portBase}` : ''}
          </span>
        {:else if connection.infoError}
          <strong class="bad">bridge unreachable</strong>
          <span class="dim">{connection.infoError}</span>
        {:else}
          <span class="dim">connecting…</span>
        {/if}
      </div>

      <div class="right">
        {#if connection.info}
          <button
            class="ro"
            class:on={connection.info.readOnly}
            disabled={flipping}
            onclick={toggleReadOnly}
            title="Refuse every mutating RPC across this site"
          >
            {connection.info.readOnly ? 'read-only ON' : 'read-only off'}
          </button>
        {/if}
        <span class="health" class:degraded={connection.health === 'degraded'}>
          {connection.health === 'up' ? 'fleet reachable' : 'fleet unreachable'}
        </span>
      </div>
    </header>

    {#if connection.health === 'degraded'}
      <div class="banner">
        The fleet is not answering. Panels will show the last values they had. Streams reconnect on
        their own — check <code>./infra/status.sh</code>.
      </div>
    {/if}

    <main>{@render children()}</main>
  </div>
</div>

<style>
  .shell {
    display: grid;
    grid-template-columns: auto 1fr;
    height: 100%;
  }
  .rail {
    display: flex;
    flex-direction: column;
    gap: var(--sp-1);
    padding: var(--sp-3) var(--sp-2);
    background: var(--bg-surface);
    border-right: var(--border-w) solid var(--border-default);
    width: 76px;
  }
  .brand {
    display: grid;
    place-items: center;
    width: 100%;
    height: 36px;
    margin-bottom: var(--sp-4);
    font-weight: var(--fw-bold);
    color: var(--accent-fg);
    background: var(--accent);
    border-radius: var(--radius-md);
  }
  .item {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 2px;
    padding: var(--sp-2) 0;
    border-radius: var(--radius-md);
    color: var(--fg-muted);
    text-decoration: none;
    transition: background var(--dur-fast) var(--ease);
  }
  .item:hover:not(.disabled) {
    background: var(--bg-hover);
    color: var(--fg-default);
  }
  .item.active {
    background: var(--bg-selected);
    color: var(--accent);
  }
  .item.disabled {
    opacity: 0.38;
    cursor: not-allowed;
  }
  .icon {
    font-size: var(--fs-lg);
    line-height: 1;
  }
  .label {
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }
  .main {
    display: flex;
    flex-direction: column;
    min-width: 0;
    min-height: 0;
  }
  .topbar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--sp-4);
    padding: var(--sp-3) var(--sp-5);
    background: var(--bg-surface);
    border-bottom: var(--border-w) solid var(--border-default);
  }
  .env {
    display: flex;
    align-items: baseline;
    gap: var(--sp-3);
    font-size: var(--fs-sm);
  }
  .dim {
    color: var(--fg-subtle);
    font-size: var(--fs-xs);
  }
  .bad {
    color: var(--status-error);
  }
  .right {
    display: flex;
    align-items: center;
    gap: var(--sp-4);
  }
  .health {
    font-size: var(--fs-xs);
    color: var(--status-running);
  }
  .health.degraded {
    color: var(--status-error);
  }
  .ro {
    font: var(--fw-medium) var(--fs-xs) var(--font-ui);
    padding: var(--sp-1) var(--sp-3);
    border-radius: var(--radius-sm);
    border: var(--border-w) solid var(--border-default);
    background: var(--bg-raised);
    color: var(--fg-muted);
    cursor: pointer;
  }
  .ro.on {
    background: var(--status-degraded);
    border-color: var(--status-degraded);
    color: #000;
  }
  .ro:disabled {
    opacity: 0.5;
    cursor: wait;
  }
  .banner {
    padding: var(--sp-2) var(--sp-5);
    background: var(--accent-subtle);
    color: var(--fg-default);
    font-size: var(--fs-sm);
    border-bottom: var(--border-w) solid var(--border-default);
  }
  main {
    flex: 1;
    min-height: 0;
    padding: var(--sp-5);
    overflow: auto;
  }
</style>
