/**
 * certs — the bridge's TLS material.
 *
 * **h2/TLS is mandatory, not polish.** Browsers only multiplex HTTP/2 over TLS,
 * and without multiplexing a workspace's live streams starve the ~6 connections
 * a browser allows per origin over HTTP/1.1 — panels then hang rather than
 * fail, which is the worse outcome. So the bridge refuses to start without a
 * certificate rather than quietly falling back to something that appears to
 * work until the sixth stream.
 *
 * `mkcert` is the preferred source (it installs a local CA, so the browser
 * trusts the cert without an interstitial). `scripts/gen-cert.sh` falls back to
 * a self-signed openssl cert, which works but makes the browser complain once.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface TlsMaterial {
  key: Buffer;
  cert: Buffer;
}

export class MissingCertError extends Error {
  constructor(dir: string) {
    super(
      [
        `No TLS certificate in ${dir}.`,
        '',
        'The bridge serves h2 over TLS because browsers only multiplex HTTP/2',
        'over TLS; without it the console starves on ~6 HTTP/1.1 connections.',
        '',
        'Generate one:  pnpm --filter @salus-gui/bridge cert',
        '(uses mkcert when installed — a trusted local CA — else self-signed openssl)',
      ].join('\n'),
    );
    this.name = 'MissingCertError';
  }
}

/** Load `bridge-key.pem` + `bridge.pem`. Throws MissingCertError when absent. */
export function loadTls(dir: string): TlsMaterial {
  try {
    return {
      key: readFileSync(join(dir, 'bridge-key.pem')),
      cert: readFileSync(join(dir, 'bridge.pem')),
    };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') throw new MissingCertError(dir);
    throw err;
  }
}
