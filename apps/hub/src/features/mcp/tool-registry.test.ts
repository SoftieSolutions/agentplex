import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { defineMcpTool, registerTool, type McpTool } from './tool-registry.js';

/**
 * The seam every later tool is written against, exercised over a pair of
 * in-memory transports.
 *
 * No port and no HTTP: what is under test is the shape a tool is declared in,
 * the schema a client is shown, and what a handler's string becomes on the
 * wire. The MCP client and server are the real ones, because the value of this
 * seam is entirely in what the SDK does with what it is handed -- a fake would
 * assert that this file calls itself the way this file calls itself.
 */

async function connected(tools: readonly McpTool[]): Promise<Client> {
  const server = new McpServer({ name: 'agentplex-hub', version: '0.0.0' });
  for (const tool of tools) registerTool(server, tool);

  const [clientEnd, serverEnd] = InMemoryTransport.createLinkedPair();
  await server.connect(serverEnd);

  const client = new Client({ name: 'tool-registry.test', version: '0.0.0' });
  await client.connect(clientEnd);
  return client;
}

const greet = defineMcpTool({
  name: 'greet',
  description: 'Says hello to somebody.',
  input: { who: z.string().describe('The name to greet.') },
  run: ({ who }) => `hello ${who}`,
});

describe('the MCP tool registry', () => {
  it('lists a tool by the name and description it was declared with', async () => {
    const client = await connected([greet]);

    const { tools } = await client.listTools();

    expect(tools).toHaveLength(1);
    expect(tools[0]).toMatchObject({ name: 'greet', description: 'Says hello to somebody.' });
  });

  it('shows the client the JSON Schema its zod shape means', async () => {
    const client = await connected([greet]);

    const { tools } = await client.listTools();

    // The one thing a tool author cannot check by reading their own file: that
    // the schema handed to a model is the schema they wrote. `describe` is what
    // becomes the per-argument documentation, and losing it is silent.
    expect(tools[0]?.inputSchema).toMatchObject({
      type: 'object',
      properties: { who: { type: 'string', description: 'The name to greet.' } },
      required: ['who'],
    });
  });

  it('turns what a handler returns into one text content block', async () => {
    const client = await connected([greet]);

    const result = await client.callTool({ name: 'greet', arguments: { who: 'robert' } });

    expect(result.content).toEqual([{ type: 'text', text: 'hello robert' }]);
    expect(result.isError).toBeFalsy();
  });

  it('gives the handler parsed arguments rather than whatever arrived', async () => {
    // The handler below would throw on anything that is not a string, and it is
    // never reached: the call is refused before it, against the same shape the
    // listing published. A tool author writes against the type and not against
    // a claim.
    const strict = defineMcpTool({
      name: 'strict',
      description: 'Refuses anything that is not a string.',
      input: { who: z.string() },
      run: ({ who }) => who.toUpperCase(),
    });
    const client = await connected([strict]);

    const result = await client.callTool({ name: 'strict', arguments: { who: 7 } });

    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain('expected string');
  });

  it('carries a tool that takes no arguments', async () => {
    const nothing = defineMcpTool({
      name: 'nothing',
      description: 'Takes no arguments.',
      input: {},
      run: () => 'done',
    });
    const client = await connected([nothing]);

    const { tools } = await client.listTools();
    const result = await client.callTool({ name: 'nothing', arguments: {} });

    expect(tools[0]?.inputSchema).toMatchObject({ type: 'object', properties: {} });
    expect(result.content).toEqual([{ type: 'text', text: 'done' }]);
  });

  it('reports a handler that threw as a failed call rather than a broken session', async () => {
    // One tool falling over is that tool's problem. A throw that reached the
    // transport would take the connection with it, and every other tool on this
    // endpoint with it.
    const broken = defineMcpTool({
      name: 'broken',
      description: 'Always fails.',
      input: {},
      run: () => {
        throw new Error('the store is unreadable');
      },
    });
    const client = await connected([broken, greet]);

    const failed = await client.callTool({ name: 'broken', arguments: {} });
    const after = await client.callTool({ name: 'greet', arguments: { who: 'robert' } });

    expect(failed.isError).toBe(true);
    expect(after.content).toEqual([{ type: 'text', text: 'hello robert' }]);
  });

  it('awaits a handler that returns a promise', async () => {
    const slow = defineMcpTool({
      name: 'slow',
      description: 'Answers later.',
      input: {},
      run: () => Promise.resolve('eventually'),
    });
    const client = await connected([slow]);

    expect((await client.callTool({ name: 'slow', arguments: {} })).content).toEqual([
      { type: 'text', text: 'eventually' },
    ]);
  });
});
