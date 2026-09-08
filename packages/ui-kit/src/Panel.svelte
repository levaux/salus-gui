<script lang="ts">
  /** Panel chrome: a title bar with room for status on the right, and a body. */
  interface Props {
    title: string;
    subtitle?: string | undefined;
    actions?: import('svelte').Snippet;
    children: import('svelte').Snippet;
    /** Let the body scroll rather than the page. */
    scroll?: boolean;
  }

  const { title, subtitle, actions, children, scroll = false }: Props = $props();
</script>

<section class="panel">
  <header>
    <div class="titles">
      <h2>{title}</h2>
      {#if subtitle}<span class="subtitle">{subtitle}</span>{/if}
    </div>
    {#if actions}<div class="actions">{@render actions()}</div>{/if}
  </header>
  <div class="body" class:scroll>{@render children()}</div>
</section>

<style>
  .panel {
    display: flex;
    flex-direction: column;
    min-height: 0;
    background: var(--bg-surface);
    border: var(--border-w) solid var(--border-default);
    border-radius: var(--radius-lg);
    overflow: hidden;
  }
  header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--sp-4);
    padding: var(--sp-3) var(--sp-4);
    border-bottom: var(--border-w) solid var(--border-subtle);
    background: var(--bg-raised);
  }
  .titles {
    display: flex;
    align-items: baseline;
    gap: var(--sp-3);
    min-width: 0;
  }
  h2 {
    margin: 0;
    font-size: var(--fs-md);
    font-weight: var(--fw-bold);
    color: var(--fg-default);
  }
  .subtitle {
    font-size: var(--fs-xs);
    color: var(--fg-subtle);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .actions {
    display: flex;
    align-items: center;
    gap: var(--sp-3);
    flex: 0 0 auto;
  }
  .body {
    flex: 1;
    min-height: 0;
    padding: var(--sp-4);
  }
  .body.scroll {
    overflow: auto;
  }
</style>
