/**
 * SeriesBuffer — columnar Float64Array ring with zero per-frame allocation:
 * per-RPC latency percentiles, health metric series, therapy telemetry. One
 * timestamp column plus N value columns, all fixed-capacity rings.
 *
 * `toColumns()` returns aligned arrays ordered oldest → newest, the shape a
 * plotting library's `setData` expects: `[xs, y0, y1, …]`.
 */
export class SeriesBuffer {
  private readonly cap: number;
  private readonly seriesCount: number;
  private readonly xs: Float64Array;
  private readonly ys: Float64Array[];
  private head = 0;
  private count = 0;
  generation = 0;

  constructor(seriesCount: number, capacity = 100_000) {
    if (seriesCount <= 0) throw new RangeError('SeriesBuffer needs ≥1 series');
    if (capacity <= 0) throw new RangeError('SeriesBuffer capacity must be > 0');
    this.cap = capacity;
    this.seriesCount = seriesCount;
    this.xs = new Float64Array(capacity);
    this.ys = Array.from({ length: seriesCount }, () => new Float64Array(capacity));
  }

  get size(): number {
    return this.count;
  }

  /** Append one sample. `values.length` must equal seriesCount. */
  push(x: number, values: readonly number[]): void {
    if (values.length !== this.seriesCount) {
      throw new RangeError(`expected ${this.seriesCount} values, got ${values.length}`);
    }
    this.xs[this.head] = x;
    for (let s = 0; s < this.seriesCount; s++) this.ys[s]![this.head] = values[s]!;
    this.head = (this.head + 1) % this.cap;
    if (this.count < this.cap) this.count++;
    this.generation++;
  }

  clear(): void {
    this.head = 0;
    this.count = 0;
    this.generation++;
  }

  /** Plot-shaped data: `[xs, ...series]`, each oldest → newest. */
  toColumns(): [number[], ...number[][]] {
    const start = this.count < this.cap ? 0 : this.head;
    const xs: number[] = new Array(this.count);
    const series: number[][] = this.ys.map(() => new Array<number>(this.count));
    for (let i = 0; i < this.count; i++) {
      const idx = (start + i) % this.cap;
      xs[i] = this.xs[idx]!;
      for (let s = 0; s < this.seriesCount; s++) series[s]![i] = this.ys[s]![idx]!;
    }
    return [xs, ...series];
  }
}
