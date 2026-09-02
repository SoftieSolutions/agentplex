import { afterEach, describe, expect, it } from 'vitest';
import { sendJson, startHttpServer, type HttpListener } from './http.js';

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
