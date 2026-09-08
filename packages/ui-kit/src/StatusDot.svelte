<script lang="ts">
  import { statusName } from './format.js';

  /**
   * A service's status, as a coloured dot plus its name.
   *
   * The name is always rendered, never colour alone: a colour-only status is
   * unreadable to a colour-blind operator and invisible in a screenshot pasted
   * into an incident thread.
   */
  interface Props {
    /** `Salus.Common.ServiceStatus` numeric value. */
    status: number | undefined;
    /** Hide the text, for dense rows where a column header already says what it is. */
    dotOnly?: boolean;
  }

  const { status, dotOnly = false }: Props = $props();
  const name = $derived(statusName(status));
</script>

<span class="status" title={name}>
  <span class="dot" style="background: var(--status-{name})"></span>
  {#if !dotOnly}<span class="label">{name}</span>{/if}
</span>

<style>
  .status {
    display: inline-flex;
    align-items: center;
    gap: var(--sp-2);
    white-space: nowrap;
  }
  .dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    flex: 0 0 auto;
  }
  .label {
    font-size: var(--fs-xs);
    color: var(--fg-muted);
    text-transform: uppercase;
    letter-spacing: 0.03em;
  }
</style>
