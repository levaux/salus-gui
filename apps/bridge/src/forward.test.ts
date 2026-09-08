import { describe, expect, it } from 'vitest';
import { Code, ConnectError } from '@connectrpc/connect';
import {
  copyResponseHeaders,
  forwardableRequestHeaders,
  isClientDisconnect,
  scrubErrorMetadata,
} from './forward.js';
import { ADMIN_TARGET_HEADER } from './headers.js';

describe('request header hygiene', () => {
  it('passes the resume and auth keys through verbatim', () => {
    // This is the whole reason seq resume needs no bridge special-casing, and
    // what will make bearer pass-through work when the token workbench lands.
    const from = new Headers({
      'salus-log-since-seq': '412',
      'salus-lifecycle-since-seq': '7',
      authorization: 'Bearer abc.def.ghi',
      'x-user-id': 'edge-client-001',
    });
    const out = forwardableRequestHeaders(from);
    expect(out.get('salus-log-since-seq')).toBe('412');
    expect(out.get('salus-lifecycle-since-seq')).toBe('7');
    expect(out.get('authorization')).toBe('Bearer abc.def.ghi');
    expect(out.get('x-user-id')).toBe('edge-client-001');
  });

  it('drops connection-specific headers HTTP/2 forbids', () => {
    // Node's HTTP/2 client rejects these outright
    // (ERR_HTTP2_INVALID_CONNECTION_HEADERS), so forwarding one fails the call.
    const from = new Headers({
      connection: 'keep-alive',
      'keep-alive': 'timeout=5',
      'transfer-encoding': 'chunked',
      upgrade: 'h2c',
      host: 'localhost:56400',
    });
    const out = forwardableRequestHeaders(from);
    for (const k of ['connection', 'keep-alive', 'transfer-encoding', 'upgrade', 'host']) {
      expect(out.get(k), k).toBeNull();
    }
  });

  it('drops framing and protocol headers the upstream transport sets itself', () => {
    const from = new Headers({
      'content-type': 'application/connect+proto',
      'content-length': '42',
      'connect-protocol-version': '1',
      'connect-timeout-ms': '5000',
      te: 'trailers',
    });
    const out = forwardableRequestHeaders(from);
    for (const k of [
      'content-type',
      'content-length',
      'connect-protocol-version',
      'connect-timeout-ms',
      'te',
    ]) {
      expect(out.get(k), k).toBeNull();
    }
  });

  it('consumes the admin-target directive rather than forwarding it', () => {
    // It selects which Component the bridge dials; upstream it means nothing.
    const out = forwardableRequestHeaders(
      new Headers({ [ADMIN_TARGET_HEADER]: '127.0.0.1:57030' }),
    );
    expect(out.get(ADMIN_TARGET_HEADER)).toBeNull();
  });
});

describe('response header hygiene', () => {
  it('copies custom metadata back but not gRPC framing', () => {
    const from = new Headers({
      'content-type': 'application/grpc+proto',
      'grpc-status': '0',
      'grpc-encoding': 'identity',
      'salus-log-since-seq': '999',
    });
    const to = new Headers();
    copyResponseHeaders(from, to);
    // Copying the gRPC content-type would clobber the Connect one the adapter
    // set, and the browser client then rejects the whole response.
    expect(to.get('content-type')).toBeNull();
    expect(to.get('grpc-status')).toBeNull();
    expect(to.get('grpc-encoding')).toBeNull();
    expect(to.get('salus-log-since-seq')).toBe('999');
  });

  it("scrubs the same headers off an error's metadata", () => {
    const err = new ConnectError('upstream exploded', Code.Unavailable);
    err.metadata.set('content-type', 'application/grpc');
    err.metadata.set('salus-detail', 'clickhouse disconnected');

    const scrubbed = scrubErrorMetadata(err);
    // Left alone, the gRPC content-type rides along and the browser sees a
    // bare HTTP status instead of the backend's actual reason.
    expect(scrubbed.metadata.get('content-type')).toBeNull();
    expect(scrubbed.metadata.get('salus-detail')).toBe('clickhouse disconnected');
    expect(scrubbed.code).toBe(Code.Unavailable);
    expect(scrubbed.rawMessage).toBe('upstream exploded');
  });

  it('wraps a non-Connect error so the browser still gets a Connect error', () => {
    const scrubbed = scrubErrorMetadata(new Error('socket hang up'));
    expect(scrubbed).toBeInstanceOf(ConnectError);
    expect(scrubbed.rawMessage).toContain('socket hang up');
  });
});

describe('client disconnect classification', () => {
  it('treats a cancel as routine', () => {
    expect(isClientDisconnect(new ConnectError('canceled', Code.Canceled))).toBe(true);
  });

  it('recognises the h2 resets a browser sends on reload, HMR and tab close', () => {
    for (const message of [
      'stream closed with error code CANCEL',
      'stream closed with error code INTERNAL_ERROR',
      'protocol error: missing status',
    ]) {
      expect(isClientDisconnect(new ConnectError(message, Code.Internal)), message).toBe(true);
      expect(isClientDisconnect(new ConnectError(message, Code.Aborted)), message).toBe(true);
    }
  });

  it('does NOT swallow a real upstream fault', () => {
    // The whole point of the classification is that real faults keep their
    // stack. An INTERNAL that is not an h2 reset is a genuine failure.
    expect(isClientDisconnect(new ConnectError('index out of range', Code.Internal))).toBe(false);
    expect(isClientDisconnect(new ConnectError('unavailable', Code.Unavailable))).toBe(false);
    expect(isClientDisconnect(new ConnectError('bad request', Code.InvalidArgument))).toBe(false);
    expect(isClientDisconnect(new Error('stream closed with error code CANCEL'))).toBe(false);
    expect(isClientDisconnect(undefined)).toBe(false);
  });

  it('does not treat a stream closed with a PROTOCOL_ERROR code as routine', () => {
    // Only CANCEL and INTERNAL_ERROR are the browser's normal teardown codes;
    // anything else is worth a stack.
    expect(
      isClientDisconnect(
        new ConnectError('stream closed with error code PROTOCOL_ERROR', Code.Internal),
      ),
    ).toBe(false);
  });
});
