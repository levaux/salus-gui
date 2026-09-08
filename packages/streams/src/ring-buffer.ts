/**
 * RingBuffer — fixed-capacity FIFO for logs, lifecycle events and harness
 * output. Overwrites the oldest entry when full. A monotonically increasing
 * `generation` lets a virtualised view cheaply answer "has anything changed
 * since I last rendered?" without diffing.
 */
export class RingBuffer<T> {
  private readonly buf: (T | undefined)[];
  private readonly cap: number;
  private head = 0; // index of the next write
  private count = 0;
  /** Bumped on every mutation — a change token for virtualised re-render. */
  generation = 0;

  constructor(capacity = 50_000) {
    if (capacity <= 0) throw new RangeError('RingBuffer capacity must be > 0');
    this.cap = capacity;
    this.buf = new Array<T | undefined>(capacity);
  }

  get size(): number {
    return this.count;
  }

  get capacity(): number {
    return this.cap;
  }

  push(item: T): void {
    this.buf[this.head] = item;
    this.head = (this.head + 1) % this.cap;
    if (this.count < this.cap) this.count++;
    this.generation++;
  }

  pushMany(items: Iterable<T>): void {
    for (const it of items) {
      this.buf[this.head] = it;
      this.head = (this.head + 1) % this.cap;
      if (this.count < this.cap) this.count++;
    }
    this.generation++;
  }

  clear(): void {
    this.head = 0;
    this.count = 0;
    this.buf.fill(undefined);
    this.generation++;
  }

  /** Oldest → newest. An optional predicate filters without an intermediate copy. */
  snapshot(pred?: (item: T) => boolean): T[] {
    const out: T[] = [];
    const start = this.count < this.cap ? 0 : this.head;
    for (let i = 0; i < this.count; i++) {
      const item = this.buf[(start + i) % this.cap];
      if (item !== undefined && (pred === undefined || pred(item))) out.push(item);
    }
    return out;
  }

  /** The most recent `n` entries, oldest → newest. */
  tail(n: number): T[] {
    const take = Math.min(n, this.count);
    const out: T[] = [];
    const start = this.count < this.cap ? 0 : this.head; // logical-oldest index
    for (let i = this.count - take; i < this.count; i++) {
      const item = this.buf[(start + i) % this.cap];
      if (item !== undefined) out.push(item);
    }
    return out;
  }
}
