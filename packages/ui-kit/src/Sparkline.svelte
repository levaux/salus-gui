<script lang="ts">
  /**
   * Sparkline — a fixed-height trend line, auto-scaled to its own window.
   *
   * Deliberately not a chart: no axes, no ticks, no library. It answers one
   * question — is this going up, down, or flat — at a glance, beside the number
   * it belongs to.
   *
   * Scaled to the window maximum rather than a fixed ceiling, because the
   * interesting comparison is a component against its own recent past. A shared
   * scale would flatten every quiet service into a dead line the moment one
   * busy service arrived.
   */
  interface Props {
    values: number[];
    /** Stroke colour — the caller passes a token, never a literal. */
    colour?: string;
    height?: number;
  }

  const { values, colour = 'currentColor', height = 14 }: Props = $props();

  const points = $derived.by(() => {
    if (values.length < 2) return '';
    const max = Math.max(...values);
    // A flat run of zeros must render on the baseline, not fill the box: a
    // sparkline that shows a full-height line for "nothing happened" is worse
    // than showing none at all.
    const scale = max > 0 ? max : 1;
    const step = 100 / (values.length - 1);
    return values
      .map((v, i) => `${(i * step).toFixed(2)},${(height - (v / scale) * height).toFixed(2)}`)
      .join(' ');
  });
</script>

{#if points === ''}
  <!-- Not enough samples yet. An empty box is honest; a straight line would
       imply a measurement that has not been taken. -->
  <div class="empty" style="height: {height}px"></div>
{:else}
  <svg
    viewBox="0 0 100 {height}"
    preserveAspectRatio="none"
    style="height: {height}px"
    aria-hidden="true"
  >
    <polyline
      {points}
      fill="none"
      stroke={colour}
      stroke-width="1.2"
      stroke-linejoin="round"
      vector-effect="non-scaling-stroke"
    />
  </svg>
{/if}

<style>
  svg {
    display: block;
    width: 100%;
    overflow: visible;
  }
  .empty {
    width: 100%;
  }
</style>
