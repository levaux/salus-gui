<script lang="ts">
  import { levelName, timeOfDay } from './format.js';

  /**
   * A live log console.
   *
   * Two behaviours that matter more than they look:
   *
   * **Follow releases when you scroll up.** A view that yanks you back to the
   * bottom while you are reading the line that caused an incident is worse than
   * one that never follows. Scrolling away turns follow off; scrolling back to
   * the bottom turns it on again.
   *
   * **Rows are keyed by `seq`, not by index.** The feed resumes by sequence
   * after a reconnect, so index keying would re-render every row on each
   * arrival and lose the reader's position.
   */
  interface LogRow {
    seq: bigint;
    timestampUs: bigint;
    level: number;
    label: string;
    message: string;
    service?: string;
  }

  interface Props {
    rows: LogRow[];
    /** Show which service emitted the line — on for the aggregate feed. */
    showService?: boolean;
    empty?: string;
  }

  const { rows, showService = false, empty = 'No log lines yet' }: Props = $props();

  let viewport = $state<HTMLDivElement>();
  let following = $state(true);

  function onScroll(): void {
    if (!viewport) return;
    // A small tolerance: "at the bottom" should survive sub-pixel rounding and
    // a partially-visible last row.
    const distance = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight;
    following = distance < 24;
  }

  // Re-runs whenever the row set changes; only scrolls while following.
  $effect(() => {
    void rows.length;
    if (following && viewport) viewport.scrollTop = viewport.scrollHeight;
  });
</script>

<div class="log">
  <div class="viewport" bind:this={viewport} onscroll={onScroll}>
    {#each rows as row (row.seq)}
      {@const level = levelName(row.level)}
      <div class="line">
        <span class="time">{timeOfDay(row.timestampUs)}</span>
        <span class="level" style="color: var(--sev-{level})">{level}</span>
        {#if showService}<span class="service">{row.service ?? ''}</span>{/if}
        <span class="label">{row.label}</span>
        <span class="message">{row.message}</span>
      </div>
    {:else}
      <div class="empty">{empty}</div>
    {/each}
  </div>
  {#if !following}
    <button
      class="resume"
      onclick={() => {
        following = true;
        if (viewport) viewport.scrollTop = viewport.scrollHeight;
      }}
    >
      Jump to latest
    </button>
  {/if}
</div>

<style>
  .log {
    position: relative;
    height: 100%;
    min-height: 0;
    border: var(--border-w) solid var(--border-subtle);
    border-radius: var(--radius-md);
    background: var(--bg-sunken);
    overflow: hidden;
  }
  .viewport {
    height: 100%;
    overflow: auto;
    padding: var(--sp-2) 0;
  }
  .line {
    display: grid;
    grid-template-columns: auto auto auto minmax(0, max-content) minmax(0, 1fr);
    gap: var(--sp-3);
    padding: 1px var(--sp-3);
    font-family: var(--font-mono);
    font-size: var(--fs-xs);
    line-height: var(--lh-normal);
    white-space: pre-wrap;
    word-break: break-word;
  }
  .line:hover {
    background: var(--bg-hover);
  }
  .time {
    color: var(--fg-subtle);
    font-variant-numeric: var(--num-variant);
  }
  .level {
    text-transform: uppercase;
    min-width: 3.5em;
  }
  .service {
    color: var(--accent);
    min-width: 8em;
  }
  .label {
    color: var(--fg-muted);
  }
  .message {
    color: var(--fg-default);
  }
  .empty {
    padding: var(--sp-6);
    text-align: center;
    color: var(--fg-subtle);
    font-size: var(--fs-sm);
  }
  .resume {
    position: absolute;
    right: var(--sp-4);
    bottom: var(--sp-4);
    padding: var(--sp-2) var(--sp-3);
    font: var(--fw-medium) var(--fs-xs) var(--font-ui);
    color: var(--accent-fg);
    background: var(--accent);
    border: none;
    border-radius: var(--radius-sm);
    cursor: pointer;
    box-shadow: var(--shadow-md);
  }
  .resume:hover {
    background: var(--accent-hover);
  }
</style>
