<script lang="ts" generics="Row">
  /**
   * DataGrid — the one table wrapper every blotter goes through.
   *
   * The point of this component is the **seam**, not the implementation. Today
   * it renders a plain table, which is the right answer for the row counts the
   * console currently shows (a six-service registry, a session roster). When a
   * panel genuinely needs virtualisation, sorting and column pinning at
   * thousands of rows, the library goes in *here* and every call site is
   * unchanged — that is the whole reason panels never touch a grid library
   * directly.
   *
   * Deliberately not reaching for a grid library yet: no measured problem, and
   * a heavyweight dependency added before one is a cost the console pays on
   * every load for a capability it is not using.
   */
  // Deliberately not generic: a column descriptor names a field and how to
  // align it, and carries nothing of the row type. Parameterising it added a
  // type variable no member used.
  interface Column {
    key: string;
    header: string;
    /** Right-align and use tabular figures — for anything the eye scans down. */
    numeric?: boolean;
    width?: string;
  }

  interface Props<R> {
    columns: Column[];
    rows: R[];
    /** Stable identity per row. Keying by array index makes every update a churn. */
    rowKey: (row: R) => string;
    /** What to show when there are no rows — never a blank panel. */
    empty?: string;
    selected?: string | undefined;
    onselect?: (row: R) => void;
    children?: import('svelte').Snippet<[R, Column]>;
  }

  const {
    columns,
    rows,
    rowKey,
    empty = 'Nothing to show',
    selected,
    onselect,
    children,
  }: Props<Row> = $props();
</script>

<div class="grid-wrap">
  <table>
    <thead>
      <tr>
        {#each columns as col (col.key)}
          <th class:numeric={col.numeric} style={col.width ? `width: ${col.width}` : undefined}>
            {col.header}
          </th>
        {/each}
      </tr>
    </thead>
    <tbody>
      {#each rows as row (rowKey(row))}
        <tr
          class:selected={selected !== undefined && rowKey(row) === selected}
          class:clickable={onselect !== undefined}
          onclick={() => onselect?.(row)}
        >
          {#each columns as col (col.key)}
            <td class:numeric={col.numeric}>
              {#if children}{@render children(row, col)}{/if}
            </td>
          {/each}
        </tr>
      {:else}
        <tr class="empty">
          <td colspan={columns.length}>{empty}</td>
        </tr>
      {/each}
    </tbody>
  </table>
</div>

<style>
  .grid-wrap {
    overflow: auto;
    border: var(--border-w) solid var(--border-subtle);
    border-radius: var(--radius-md);
    background: var(--bg-surface);
  }
  table {
    width: 100%;
    border-collapse: collapse;
    font-size: var(--fs-sm);
  }
  th {
    position: sticky;
    top: 0;
    z-index: 1;
    text-align: left;
    font-weight: var(--fw-medium);
    font-size: var(--fs-xs);
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--fg-subtle);
    background: var(--bg-sunken);
    padding: var(--sp-2) var(--sp-3);
    border-bottom: var(--border-w) solid var(--border-default);
    white-space: nowrap;
  }
  td {
    padding: var(--sp-2) var(--sp-3);
    border-bottom: var(--border-w) solid var(--border-subtle);
    color: var(--fg-default);
    vertical-align: middle;
  }
  .numeric {
    text-align: right;
    font-family: var(--font-mono);
    font-variant-numeric: var(--num-variant);
  }
  tbody tr.clickable {
    cursor: pointer;
  }
  tbody tr.clickable:hover {
    background: var(--bg-hover);
  }
  tbody tr.selected {
    background: var(--bg-selected);
  }
  tr.empty td {
    text-align: center;
    color: var(--fg-subtle);
    padding: var(--sp-6);
  }
</style>
