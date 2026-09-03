import { connect } from 'node:net';
import { once } from 'node:events';
import { afterEach, describe, expect, it } from 'vitest';
import { HTTP_TIMEOUTS, sendJson, startHttpServer, type HttpListener } from './http.js';

let listener: HttpListener | undefined;

afterEach(async () => {
  await listener?.close();
  listener = undefined;
});

describe('startHttpServer', () => {
  it('reports the port it actually bound, not the one it was asked for', async () => {
    listener = await startHttpServer(0, '127.0.0.1', (_request, response) => {
      sendJson(response, 200, { status: 'ok' });
    });
    expect(listener.port).toBeGreaterThan(0);
  });

  it('serves the handler', async () => {
    listener = await startHttpServer(0, '127.0.0.1', (_request, response) => {
      sendJson(response, 200, { status: 'ok' });
    });
    const response = await fetch(`http://127.0.0.1:${listener.port}/health`);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ status: 'ok' });
  });

  it('rejects rather than resolving when the port cannot be bound', async () => {
    listener = await startHttpServer(0, '127.0.0.1', (_request, response) => response.end());
    await expect(
      startHttpServer(listener.port, '127.0.0.1', (_r, response) => response.end()),
    ).rejects.toThrow();
  });

  it('refuses connections once closed', async () => {
    const closing = await startHttpServer(0, '127.0.0.1', (_request, response) => response.end());
    const { port } = closing;
    await closing.close();
    await expect(fetch(`http://127.0.0.1:${port}/health`)).rejects.toThrow();
  });
});

describe('startHttpServer timeouts', () => {
  it('keeps the header deadline inside the request deadline', () => {
    // The other way round, a request would be cut off before its headers were
    // due, and the header timeout would never be the thing that fired.
    expect(HTTP_TIMEOUTS.headersMs).toBeLessThan(HTTP_TIMEOUTS.requestMs);
  });

  it('closes a connection that opens and never finishes its headers', async () => {
    listener = await startHttpServer(0, '127.0.0.1', (_request, response) => response.end(), {
      headersMs: 100,
      requestMs: 400,
      keepAliveMs: 50,
      checkIntervalMs: 20,
    });

    const socket = connect(listener.port, '127.0.0.1');
    await once(socket, 'connect');
    // A paused socket never reaches end-of-stream, so it would never see the
    // close it is about to be sent.
    socket.resume();
    // A request line and one header, and then nothing: the slowloris shape.
    socket.write('GET /health HTTP/1.1\r\nHost: localhost\r\n');

    // Without a header timeout this waits for the test timeout instead.
    await once(socket, 'close');
    expect(socket.destroyed).toBe(true);
  });
});
