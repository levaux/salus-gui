/**
 * audit — what the console did, and to which fleet.
 *
 * Two sinks: a bounded in-memory ring the `/bridge/audit` endpoint serves, and
 * an append-only NDJSON file per site. The file is the one that matters — an
 * operator asking "who drained Therapy at 3am" is asking a question the ring
 * cannot answer after a restart.
 *
 * Every forwarded call is recorded, not only the mutating ones: knowing which
 * reads preceded a mutation is most of what makes an audit trail readable.
 * Requests are recorded by a cheap hash rather than their contents, because a
 * console request can carry a subject id and an audit file is not the place to
 * accumulate them.
 */
import { appendFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export interface AuditEntry {
  /** epoch ms when the call started. */
  ts: number;
  site: string;
  service: string;
  rpc: string;
  /** FNV-1a of the request — correlation only, never a security boundary. */
  argsHash: string;
  outcome: 'ok' | 'error';
  latencyMs: number;
  mutating: boolean;
}

export interface AuditOptions {
  /** Directory for the NDJSON files. Omit to keep the ring only. */
  dir?: string;
  /** Ring capacity (default 500). */
  capacity?: number;
}

export class AuditLog {
  private readonly ring: AuditEntry[] = [];
  private readonly capacity: number;
  private readonly dir: string | undefined;
  /** Serialises appends so concurrent calls cannot interleave a line. */
  private tail: Promise<void> = Promise.resolve();

  constructor(opts: AuditOptions = {}) {
    this.capacity = opts.capacity ?? 500;
    this.dir = opts.dir;
  }

  /** Record an entry. Returns a promise that settles once it is durable. */
  append(entry: AuditEntry): Promise<void> {
    this.ring.push(entry);
    if (this.ring.length > this.capacity) this.ring.shift();
    if (this.dir === undefined) return Promise.resolve();

    const file = join(this.dir, `${entry.site}.ndjson`);
    const line = JSON.stringify(entry) + '\n';
    // Chain rather than fire-and-forget: two appends racing on the same file
    // can interleave partial writes, and a corrupt audit line is worse than a
    // slow one.
    this.tail = this.tail.then(async () => {
      await mkdir(dirname(file), { recursive: true });
      await appendFile(file, line, 'utf8');
    });
    return this.tail;
  }

  /** Most recent first. */
  recent(limit = 100): AuditEntry[] {
    return this.ring.slice(-limit).reverse();
  }

  /** Wait for every queued append to reach disk (tests, and shutdown). */
  flush(): Promise<void> {
    return this.tail;
  }
}

/**
 * FNV-1a over a stable stringification. Deterministic, cheap, and BigInt-safe
 * so a request carrying int64 fields does not throw on serialisation.
 */
export function hashInput(input: unknown): string {
  let hash = 0x811c9dc5;
  const text = stableStringify(input);
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

function stableStringify(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) => {
    if (typeof v === 'bigint') return v.toString();
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      // Sort keys so an equivalent request always hashes the same, whatever
      // order the fields happened to be set in.
      return Object.fromEntries(Object.entries(v as Record<string, unknown>).sort());
    }
    return v;
  });
}
