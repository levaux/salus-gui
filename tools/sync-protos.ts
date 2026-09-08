/**
 * sync-protos — vendor the Salus protos at a pinned commit, with a drift gate.
 *
 * Plan 001 decision 3: we vendor (not submodule, not a registry). This tool
 * copies `salus/src/proto/Salus/*.proto` into `packages/proto/vendor/salus/`
 * and writes `salus-commit.lock` (pinned SHA + per-file sha256).
 *
 * `Test/` protos are deliberately not vendored: the console drives the
 * regression harness by *running* it and parsing its output, never by speaking
 * its probe protos. `EdgeControl.proto` IS vendored even though it declares no
 * service yet — its messages are the contract surface the control plane will
 * expose, and codegen emits message types for it happily.
 *
 * Modes:
 *   tsx tools/sync-protos.ts            copy protos + rewrite the lock (a bump)
 *   tsx tools/sync-protos.ts --check    verify vendor matches the lock; exit 1 on drift (CI gate)
 *
 * Source location resolves in this order:
 *   1. $SALUS_PROTO_SRC (absolute path to the Salus/ proto dir)
 *   2. ../salus/src/proto/Salus   (the intended sibling-repo layout)
 *
 * --check does NOT need the source — it hashes the vendored files and compares
 * them to the lock, so it runs in CI without the Salus checkout present. That
 * is the whole point of the lock: the gate must not depend on the thing it is
 * gating being available.
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, writeFileSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const VENDOR_DIR = join(REPO_ROOT, 'packages/proto/vendor/salus');
const LOCK_PATH = join(REPO_ROOT, 'packages/proto/salus-commit.lock');

/** Protos we deliberately do not vendor. `Test/` lives in a sibling dir we never read. */
const EXCLUDE = new Set<string>([]);

interface Lock {
  salusSha: string;
  syncedAt: string;
  source: string;
  note?: string;
  files: Record<string, string>;
}

function sha256(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

function resolveSource(): string {
  const env = process.env.SALUS_PROTO_SRC;
  if (env) return resolve(env);
  return resolve(REPO_ROOT, '../salus/src/proto/Salus');
}

function readLock(): Lock {
  return JSON.parse(readFileSync(LOCK_PATH, 'utf8')) as Lock;
}

function protoNames(dir: string): string[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.proto') && !EXCLUDE.has(f))
    .sort();
}

/** CI gate: vendored files must match the committed lock exactly. */
function check(): never {
  const lock = readLock();
  const problems: string[] = [];
  const present = new Set(protoNames(VENDOR_DIR));

  for (const [name, expected] of Object.entries(lock.files)) {
    if (!present.has(name)) {
      problems.push(`missing vendored proto: ${name}`);
      continue;
    }
    const actual = sha256(readFileSync(join(VENDOR_DIR, name)));
    if (actual !== expected) {
      problems.push(`sha mismatch: ${name}\n    lock:   ${expected}\n    vendor: ${actual}`);
    }
    present.delete(name);
  }
  for (const extra of present) problems.push(`untracked vendored proto (not in lock): ${extra}`);

  if (problems.length > 0) {
    console.error('proto drift detected:\n  ' + problems.join('\n  '));
    console.error('\nRun `pnpm sync-protos` against the pinned Salus checkout to update the lock.');
    process.exit(1);
  }
  console.log(
    `sync-protos --check: OK (${Object.keys(lock.files).length} protos match ${lock.salusSha})`,
  );
  process.exit(0);
}

/** Bump: copy from source, rewrite the lock. */
function sync(): void {
  const src = resolveSource();
  if (!existsSync(src)) {
    console.error(`Salus proto source not found: ${src}`);
    console.error('Set $SALUS_PROTO_SRC or place the salus repo as a sibling of salus-gui.');
    process.exit(1);
  }

  let salusSha = 'unknown';
  try {
    salusSha = execFileSync('git', ['-C', src, 'rev-parse', '--short', 'HEAD'], {
      encoding: 'utf8',
    }).trim();
  } catch {
    console.warn('warning: could not read the Salus git SHA; recording "unknown".');
  }

  rmSync(VENDOR_DIR, { recursive: true, force: true });
  mkdirSync(VENDOR_DIR, { recursive: true });

  const files: Record<string, string> = {};
  for (const name of protoNames(src)) {
    const buf = readFileSync(join(src, name));
    writeFileSync(join(VENDOR_DIR, name), buf);
    files[name] = sha256(buf);
  }

  const prev = existsSync(LOCK_PATH) ? readLock() : undefined;
  const lock: Lock = {
    salusSha,
    syncedAt: new Date().toISOString(),
    source: 'salus/src/proto/Salus',
    note:
      prev?.note ??
      'Vendored proto set. Test/ protos excluded — the console runs the harness rather than speaking its probes. CI runs sync-protos --check + buf breaking on every bump.',
    files,
  };
  writeFileSync(LOCK_PATH, JSON.stringify(lock, null, 2) + '\n');
  console.log(`synced ${Object.keys(files).length} protos from ${src} @ ${salusSha}`);
}

if (process.argv.includes('--check')) check();
else sync();
