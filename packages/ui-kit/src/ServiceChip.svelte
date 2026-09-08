<script lang="ts">
  import Sparkline from './Sparkline.svelte';
  import { UNKNOWN, statusName } from './format.js';

  /**
   * ServiceChip — one node of the topology, and the console's densest element.
   *
   * Built once and used for every node because it is the same element seven
   * times over: a service, the Envoy edge, a datastore and the Edge fleet all
   * answer the same shape of question — what is it, is it up, how hard is it
   * working. The variants differ only in what fills the three stat columns and
   * whether the bottom strip carries sparks or two lines of text.
   *
   * The status colour drives the rail, the dot, the pill and the RPC spark, so
   * a glance at the colour is a glance at the state. `tone` is a CSS custom
   * property rather than seven conditional classes: a caller passing a theme
   * token keeps every colour decision in the theme package.
   */
  export interface ChipStat {
    label: string;
    value: string;
    /** Draw attention: the value IS the problem, not just a number. */
    tone?: 'normal' | 'warn' | 'bad';
  }

  // `| undefined` on every optional prop is required, not noise: the workspace
  // sets `exactOptionalPropertyTypes`, under which `status?: number` refuses an
  // explicit `undefined`. A node whose status is genuinely not yet known has to
  // be expressible, and that is exactly the case this component must handle.
  interface Props {
    name: string;
    /** `Salus.Common.ServiceStatus`, or undefined for a non-service node. */
    status?: number | undefined;
    /** Overrides the status-derived pill text — `UP`, `DENY ALL`, `LIVE`. */
    pill?: string | undefined;
    /** Address line under the name; the port token is highlighted. */
    addr?: string | undefined;
    stats?: ChipStat[] | undefined;
    /** Sparkline windows. Omit for nodes with no telemetry to plot. */
    sparks?: { rpc: number[]; io: number[]; rpcLabel: string; ioLabel: string } | undefined;
    /** Two lines shown in place of the sparks — stores and the Edge fleet. */
    footer?: string[] | undefined;
    selected?: boolean | undefined;
    /** Down nodes stop pulsing: a dead thing must not look like a live one. */
    live?: boolean | undefined;
    onselect?: (() => void) | undefined;
  }

  const {
    name,
    status,
    pill,
    addr,
    stats = [],
    sparks,
    footer,
    selected = false,
    live = true,
    onselect,
  }: Props = $props();

  const label = $derived(pill ?? statusName(status).toUpperCase());
  const tone = $derived(`var(--status-${statusName(status)})`);
</script>

<button
  class="chip"
  class:selected
  style="--tone: {tone}"
  aria-pressed={selected}
  aria-label="{name} — {label}"
  onclick={() => onselect?.()}
>
  <span class="rail"></span>
  <span class="body">
    <span class="head">
      <span class="dot" class:beat={live}></span>
      <span class="name">{name}</span>
      <span class="pill">{label}</span>
    </span>

    {#if addr}
      <span class="addr">{addr}</span>
    {/if}

    {#if stats.length > 0}
      <span class="stats">
        {#each stats as s (s.label)}
          <span class="stat">
            <span class="stat-label">{s.label}</span>
            <span class="stat-value" class:warn={s.tone === 'warn'} class:bad={s.tone === 'bad'}>
              {s.value || UNKNOWN}
            </span>
          </span>
        {/each}
      </span>
    {/if}

    {#if sparks}
      <span class="sparks">
        <span class="spark">
          <span class="spark-head">
            <span class="stat-label">RPC/S</span>
            <span class="spark-value">{sparks.rpcLabel}</span>
          </span>
          <Sparkline values={sparks.rpc} colour="var(--tone)" />
        </span>
        <span class="spark">
          <span class="spark-head">
            <span class="stat-label">I/O</span>
            <span class="spark-value">{sparks.ioLabel}</span>
          </span>
          <Sparkline values={sparks.io} colour="var(--accent-data)" />
        </span>
      </span>
    {:else if footer}
      <span class="sparks">
        {#each footer as line, i (i)}
          <span class="footer-line">{line}</span>
        {/each}
      </span>
    {/if}
  </span>
</button>

<style>
  .chip {
    display: flex;
    width: 100%;
    padding: 0;
    overflow: hidden;
    text-align: left;
    background: linear-gradient(180deg, var(--bg-raised), var(--bg-surface));
    border: var(--border-w) solid var(--border-default);
    border-radius: var(--radius-lg);
    box-shadow:
      0 8px 24px -14px #000,
      inset 0 1px 0 rgb(255 255 255 / 2.5%),
      inset 0 0 0 1px color-mix(in srgb, var(--tone) 16%, transparent),
      inset 0 0 30px -18px var(--tone);
    cursor: pointer;
    font: inherit;
    color: inherit;
  }
  .chip:hover {
    border-color: var(--border-strong);
  }
  .chip.selected {
    outline: 1.5px solid color-mix(in srgb, var(--tone) 70%, transparent);
    outline-offset: 4px;
  }
  .chip:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
  }

  .rail {
    flex: 0 0 3px;
    background: var(--tone);
    box-shadow: 0 0 12px -1px var(--tone);
  }
  .body {
    flex: 1;
    min-width: 0;
    padding: 7px 9px 6px;
  }

  .head {
    display: flex;
    align-items: center;
    gap: var(--sp-2);
  }
  .dot {
    position: relative;
    flex: 0 0 6px;
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--tone);
  }
  .dot.beat::after {
    content: '';
    position: absolute;
    inset: 0;
    border-radius: 50%;
    background: var(--tone);
    animation: beat 1.6s ease-out infinite;
  }
  @keyframes beat {
    0% {
      transform: scale(1);
      opacity: 0.7;
    }
    70%,
    100% {
      transform: scale(3.2);
      opacity: 0;
    }
  }
  /* An operator watching a fleet does not need seven things pulsing at them. */
  @media (prefers-reduced-motion: reduce) {
    .dot.beat::after {
      animation: none;
    }
  }

  .name {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    font-family: var(--font-ui);
    font-size: 13px;
    font-weight: var(--fw-bold);
    line-height: 1.1;
    letter-spacing: -0.01em;
    color: var(--fg-default);
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .pill {
    flex: 0 0 auto;
    padding: 2px 4px;
    font-family: var(--font-mono);
    font-size: 8px;
    font-weight: var(--fw-bold);
    letter-spacing: 0.08em;
    color: var(--tone);
    background: color-mix(in srgb, var(--tone) 14%, transparent);
    border: var(--border-w) solid color-mix(in srgb, var(--tone) 32%, transparent);
    border-radius: var(--radius-sm);
  }

  .addr {
    display: block;
    margin-top: 3px;
    font-family: var(--font-mono);
    font-size: 9.5px;
    line-height: 1.2;
    color: var(--fg-muted);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .stats {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: var(--sp-2);
    margin-top: 6px;
  }
  .stat {
    display: block;
    min-width: 0;
  }
  .stat-label {
    display: block;
    font-family: var(--font-mono);
    font-size: 7.5px;
    font-weight: var(--fw-bold);
    letter-spacing: 0.12em;
    text-transform: uppercase;
    color: var(--fg-subtle);
  }
  .stat-value {
    display: block;
    font-family: var(--font-mono);
    font-size: 10.5px;
    font-weight: var(--fw-bold);
    line-height: 1.2;
    color: var(--fg-default);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .stat-value.warn {
    color: var(--status-degraded);
  }
  .stat-value.bad {
    color: var(--status-error);
  }

  .sparks {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: var(--sp-2);
    margin-top: 6px;
    padding-top: 5px;
    border-top: var(--border-w) solid var(--border-subtle);
  }
  .spark {
    min-width: 0;
  }
  .spark-head {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: var(--sp-1);
  }
  .spark-value {
    font-family: var(--font-mono);
    font-size: 9px;
    font-weight: var(--fw-medium);
    color: var(--fg-muted);
  }
  .footer-line {
    grid-column: 1 / -1;
    font-family: var(--font-mono);
    font-size: 9.5px;
    line-height: 1.2;
    color: var(--fg-muted);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
</style>
