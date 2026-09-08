/**
 * ConflatedTable — keyed upsert/remove at wire rate with a frame-aligned flush.
 *
 * Deltas arrive faster than any UI can paint. This buffers keep-latest-per-key
 * and flushes on a ~16 ms (≈60 fps) timer, with two output adapters: a grid
 * transaction sink (so blotters ingest on the grid's own virtualised path) and
 * a Map mirror (for reactive summary views, or a plain Map in tests).
 *
 * `applySnapshot` is the reconnect reconcile: it makes the table equal an
 * authoritative read, EVICTING keys the snapshot no longer contains. Combined
 * with subscribe-then-snapshot ordering (./resnapshot.ts), a dropped feed
 * resumes with no stale rows and no missed deltas.
 *
 * ── Keyed keep-latest is also the ClickHouse dedup ──────────────────────────
 *
 * Salus's Health and Therapy data tables are **`ReplacingMergeTree` keyed by
 * `event_id`**, and the query surfaces read them without `FINAL`. That is not a
 * bug: between a re-write and the background merge, a query legitimately
 * returns more than one row per `event_id`, and waiting for the merge would
 * make the read slower and no more correct.
 *
 * The consequence for a client is concrete. Key a table by `event_id` here and
 * the duplicates collapse to the latest, matching the table's own replace
 * semantics exactly. Key it by anything else — or push the rows into a list —
 * and you get double-counted series, double-drawn curves, and (in a keyed
 * template) a duplicate-key error that aborts a render flush and freezes the
 * surrounding UI. So: keyed by the identity the table replaces on, always.
 * Append-only display feeds whose ordering is service-owned should use
 * positional keys instead and never claim an identity they do not have.
 */

/** The subset of a grid API the adapter needs (structural — no grid dependency). */
export interface GridTransactionApi<Row = unknown> {
  applyTransactionAsync(
    tx: { add?: Row[]; update?: Row[]; remove?: Row[] },
    callback?: (res: unknown) => void,
  ): void;
}

export interface FlushScheduler {
  /** Ask for `cb` to run ~one frame later. Coalesces repeated calls. */
  request(cb: () => void): void;
  /** Cancel a pending flush. */
  cancel(): void;
}

/** Default scheduler: a single trailing timeout (works in node and the browser). */
function timerScheduler(intervalMs: number): FlushScheduler {
  let handle: ReturnType<typeof setTimeout> | undefined;
  return {
    request(cb) {
      if (handle !== undefined) return;
      handle = setTimeout(() => {
        handle = undefined;
        cb();
      }, intervalMs);
    },
    cancel() {
      if (handle !== undefined) {
        clearTimeout(handle);
        handle = undefined;
      }
    },
  };
}

export interface ConflatedTableOptions<K, Row> {
  /**
   * Extract the stable row key. For anything read out of a ReplacingMergeTree
   * table, this MUST be the column the table replaces on (`event_id`) — see the
   * module comment.
   */
  keyOf: (row: Row) => K;
  /** Flush cadence in ms (default 16 ≈ 60 fps). */
  flushIntervalMs?: number;
  /** Injectable scheduler (tests drive flushes via flushNow()). */
  scheduler?: FlushScheduler;
}

export class ConflatedTable<K, Row> {
  private readonly keyOf: (row: Row) => K;
  private readonly scheduler: FlushScheduler;

  /** Source of truth: the committed keyed set. */
  private readonly committed = new Map<K, Row>();

  /** Pending keep-latest buffer since the last flush. */
  private readonly pendingUpserts = new Map<K, Row>();
  private readonly pendingRemoves = new Set<K>();

  private readonly gridSinks = new Set<GridTransactionApi<Row>>();
  private readonly mapMirrors = new Set<Map<K, Row>>();
  private readonly flushListeners = new Set<() => void>();

  constructor(opts: ConflatedTableOptions<K, Row>) {
    this.keyOf = opts.keyOf;
    this.scheduler = opts.scheduler ?? timerScheduler(opts.flushIntervalMs ?? 16);
  }

  get size(): number {
    return this.committed.size;
  }

  get(key: K): Row | undefined {
    return this.committed.get(key);
  }

  /** Committed keys (post-flush). */
  snapshotKeys(): K[] {
    return [...this.committed.keys()];
  }

  /** Committed rows (post-flush). */
  values(): Row[] {
    return [...this.committed.values()];
  }

  /** Upsert a row (keep-latest wins within a flush window). */
  upsert(row: Row): void {
    const key = this.keyOf(row);
    this.pendingRemoves.delete(key);
    this.pendingUpserts.set(key, row);
    this.scheduler.request(() => this.flush());
  }

  /** Upsert many rows — the shape a query result arrives in. */
  upsertAll(rows: Iterable<Row>): void {
    for (const row of rows) this.upsert(row);
  }

  /** Remove by key. */
  remove(key: K): void {
    this.pendingUpserts.delete(key);
    this.pendingRemoves.add(key);
    this.scheduler.request(() => this.flush());
  }

  /**
   * Reconcile against an authoritative snapshot (the Resnapshot contract).
   * Rows in `rows` are upserted; committed keys absent from `rows` are evicted.
   * Pending deltas from a prior connection are discarded — the snapshot is the
   * new baseline, and deltas arriving AFTER it (drained from the already-open
   * stream) apply on top idempotently.
   */
  applySnapshot(rows: Iterable<Row>): void {
    this.pendingUpserts.clear();
    this.pendingRemoves.clear();

    const next = new Map<K, Row>();
    for (const row of rows) next.set(this.keyOf(row), row);

    for (const key of this.committed.keys()) {
      if (!next.has(key)) this.pendingRemoves.add(key);
    }
    for (const [, row] of next) this.pendingUpserts.set(this.keyOf(row), row);

    this.flushNow();
  }

  /** Attach a grid transaction sink. */
  toGridTransactions(api: GridTransactionApi<Row>): () => void {
    this.gridSinks.add(api);
    // Seed the grid with current committed state as an add transaction.
    if (this.committed.size > 0) api.applyTransactionAsync({ add: [...this.committed.values()] });
    return () => this.gridSinks.delete(api);
  }

  /**
   * Mirror the committed set into `target` (pass a reactive Map for live views;
   * omit for a fresh plain Map). Kept live on every flush.
   */
  toMirrorMap(target: Map<K, Row> = new Map<K, Row>()): Map<K, Row> {
    target.clear();
    for (const [k, v] of this.committed) target.set(k, v);
    this.mapMirrors.add(target);
    return target;
  }

  /** Fired after each flush — for summary views that hold no mirror. */
  onFlush(listener: () => void): () => void {
    this.flushListeners.add(listener);
    return () => this.flushListeners.delete(listener);
  }

  /** Force an immediate flush (tests, and the resnapshot binding's ordering). */
  flushNow(): void {
    this.scheduler.cancel();
    this.flush();
  }

  private flush(): void {
    if (this.pendingUpserts.size === 0 && this.pendingRemoves.size === 0) return;

    const add: Row[] = [];
    const update: Row[] = [];
    const remove: Row[] = [];

    for (const [key, row] of this.pendingUpserts) {
      if (this.committed.has(key)) update.push(row);
      else add.push(row);
      this.committed.set(key, row);
    }
    for (const key of this.pendingRemoves) {
      const existing = this.committed.get(key);
      if (existing !== undefined) {
        remove.push(existing);
        this.committed.delete(key);
      }
    }

    this.pendingUpserts.clear();
    this.pendingRemoves.clear();

    if (add.length || update.length || remove.length) {
      const tx = { add, update, remove };
      for (const api of this.gridSinks) api.applyTransactionAsync(tx);
      for (const mirror of this.mapMirrors) {
        for (const row of add) mirror.set(this.keyOf(row), row);
        for (const row of update) mirror.set(this.keyOf(row), row);
        for (const row of remove) mirror.delete(this.keyOf(row));
      }
    }
    for (const l of this.flushListeners) l();
  }
}
