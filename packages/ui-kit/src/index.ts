/**
 * @salus-gui/ui-kit — the console's components.
 *
 * Small on purpose. Panels compose these; they never reach for a UI library
 * directly, so `DataGrid` stays the one seam where a grid implementation could
 * be swapped without touching a call site.
 */
export { default as DataGrid } from './DataGrid.svelte';
export { default as LogView } from './LogView.svelte';
export { default as Panel } from './Panel.svelte';
export { default as ServiceChip } from './ServiceChip.svelte';
export { default as Sparkline } from './Sparkline.svelte';
export { default as StatusDot } from './StatusDot.svelte';
export { default as StreamBadge } from './StreamBadge.svelte';
export * from './format.js';
