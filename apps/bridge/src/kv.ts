/**
 * kv — a file-backed document store for console-local state.
 *
 * Named workspaces and saved views: things a desk setup needs to survive a
 * browser wipe and load from another machine, but which are no business of the
 * Salus platform. Deliberately dumb — one JSON document per key, no indexes, no
 * queries.
 *
 * The name rules are a path-traversal guard, not style: keys arrive from a
 * browser and are used to build a filename. `[A-Za-z0-9_-]{1,64}` admits no
 * separator and no dot, so `..` and absolute paths are unrepresentable rather
 * than filtered.
 */
import { mkdir, readFile, readdir, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const NAME = /^[A-Za-z0-9_-]{1,64}$/;

/** 256 KiB — a workspace layout is a few KB; anything near this is a mistake. */
export const MAX_DOC_BYTES = 256 * 1024;

export class KvError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'KvError';
  }
}

function checkName(kind: string, value: string): void {
  if (!NAME.test(value)) {
    throw new KvError(`invalid ${kind} '${value}': must match ${NAME.source}`, 400);
  }
}

export class KvStore {
  constructor(private readonly dir: string) {}

  private pathFor(ns: string, key: string): string {
    checkName('namespace', ns);
    checkName('key', key);
    return join(this.dir, ns, `${key}.json`);
  }

  async get(ns: string, key: string): Promise<string> {
    const file = this.pathFor(ns, key);
    try {
      return await readFile(file, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new KvError(`no such document: ${ns}/${key}`, 404);
      }
      throw err;
    }
  }

  async put(ns: string, key: string, body: string): Promise<void> {
    const file = this.pathFor(ns, key);
    if (Buffer.byteLength(body, 'utf8') > MAX_DOC_BYTES) {
      throw new KvError(`document exceeds ${MAX_DOC_BYTES} bytes`, 413);
    }
    try {
      JSON.parse(body);
    } catch {
      // Storing invalid JSON would turn every later read into a client-side
      // parse error, far from the write that caused it.
      throw new KvError('body must be valid JSON', 400);
    }
    await mkdir(join(this.dir, ns), { recursive: true });
    await writeFile(file, body, 'utf8');
  }

  async delete(ns: string, key: string): Promise<void> {
    const file = this.pathFor(ns, key);
    try {
      await unlink(file);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new KvError(`no such document: ${ns}/${key}`, 404);
      }
      throw err;
    }
  }

  /** Key names in a namespace. An unknown namespace lists empty, not 404. */
  async list(ns: string): Promise<string[]> {
    checkName('namespace', ns);
    try {
      const names = await readdir(join(this.dir, ns));
      return names
        .filter((n) => n.endsWith('.json'))
        .map((n) => n.slice(0, -5))
        .sort();
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw err;
    }
  }
}
