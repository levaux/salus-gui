<script lang="ts">
  import { streamLabel } from './format.js';

  /**
   * One stream's health.
   *
   * Every feed reports its own state, because they degrade independently — a
   * console that shows one global "connected" light cannot tell an operator
   * that the log feed is fine while the registry has been retrying for a
   * minute. `attempt` is surfaced during backoff for the same reason: the
   * difference between "retrying" and "retrying for the ninth time" is the
   * whole signal.
   */
  interface Props {
    status: string;
    attempt?: number;
    error?: string | undefined;
  }

  const { status, attempt = 0, error }: Props = $props();
  const label = $derived(streamLabel(status));
  const tone = $derived(
    status === 'live'
      ? 'var(--status-running)'
      : status === 'fatal'
        ? 'var(--status-error)'
        : status === 'backoff'
          ? 'var(--status-degraded)'
          : 'var(--status-unknown)',
  );
</script>

<span class="badge" title={error ?? label}>
  <span
    class="dot"
    class:pulse={status === 'connecting' || status === 'backoff'}
    style="background: {tone}"
  ></span>
  <span class="label"
    >{label}{#if status === 'backoff' && attempt > 1}&nbsp;×{attempt}{/if}</span
  >
</span>

<style>
  .badge {
    display: inline-flex;
    align-items: center;
    gap: var(--sp-2);
    font-size: var(--fs-xs);
    color: var(--fg-muted);
  }
  .dot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
  }
  .pulse {
    animation: pulse 1.2s var(--ease) infinite;
  }
  @keyframes pulse {
    0%,
    100% {
      opacity: 1;
    }
    50% {
      opacity: 0.35;
    }
  }
  /* An operator watching a reconnect does not need it blinking at them. */
  @media (prefers-reduced-motion: reduce) {
    .pulse {
      animation: none;
    }
  }
</style>
