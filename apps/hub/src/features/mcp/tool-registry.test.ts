import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  answers,
  defineMcpTool,
  readOnly,
  refuses,
  registerTool,
  type McpTool,
} from './tool-registry.js';

/**
 * The seam every tool is written against, exercised over a pair of in-memory
 * transports.
 *
 * No port and no HTTP: what is under test is the shape a tool is declared in,
 * the two schemas a client is shown, and what a handler's answer becomes on the
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
  output: { greeting: z.string().describe('What was said.') },
  annotations: readOnly,
  run: ({ who }) => answers({ greeting: `hello ${who}` }),
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

  it('publishes the answer shape too, so a model need not parse prose', async () => {
    const client = await connected([greet]);

    const { tools } = await client.listTools();

    expect(tools[0]?.outputSchema).toMatchObject({
      type: 'object',
      properties: { greeting: { type: 'string', description: 'What was said.' } },
      required: ['greeting'],
    });
  });

  it('says a read tool only reads, in the field a client checks before asking', async () => {
    const client = await connected([greet]);

    const { tools } = await client.listTools();

    expect(tools[0]?.annotations).toEqual({ readOnlyHint: true });
    // Absent rather than false. Both of these are meaningful only when
    // `readOnlyHint` is false, and a field that means nothing can still mislead
    // a reader.
    expect(tools[0]?.annotations).not.toHaveProperty('destructiveHint');
    expect(tools[0]?.annotations).not.toHaveProperty('idempotentHint');
  });

  it('answers with the object and the text, derived from one value', async () => {
    const client = await connected([greet]);
    // Listed first, which is what makes the client validate the structured
    // result against the published schema rather than take it on trust.
    await client.listTools();

    const result = await client.callTool({ name: 'greet', arguments: { who: 'robert' } });

    expect(result.structuredContent).toEqual({ greeting: 'hello robert' });
    // The same value, as the text every client can read without having been
    // told about structured output. Not a second sentence to keep in step.
    expect(result.content).toEqual([{ type: 'text', text: '{"greeting":"hello robert"}' }]);
    expect(result.isError).toBeFalsy();
  });

  it('lets a tool whose answer is text say so, instead of quoting itself', async () => {
    // `read_terminal` is the case: a terminal's own output escaped into a JSON
    // string is the thing the caller asked for, made unreadable.
    const transcript = defineMcpTool({
      name: 'transcript',
      description: 'Answers with text.',
      input: {},
      output: { text: z.string(), bytes: z.int() },
      annotations: readOnly,
      render: (value) => value.text,
      run: () => answers({ text: 'line one\nline two', bytes: 17 }),
    });
    const client = await connected([transcript]);

    const result = await client.callTool({ name: 'transcript', arguments: {} });

    expect(result.content).toEqual([{ type: 'text', text: 'line one\nline two' }]);
    // The structured half is untouched by the rendering: both halves are the
    // same value, read two ways.
    expect(result.structuredContent).toEqual({ text: 'line one\nline two', bytes: 17 });
  });

  it('turns a feature refusal into a failed call carrying the sentence', async () => {
    // The rule this seam exists to keep: a refusal is an answer, not a throw. A
    // machine that is asleep, a session nobody reports, a subscribe the holder
    // declined -- each is something an agent can read and act on.
    const asleep = defineMcpTool({
      name: 'asleep',
      description: 'Refuses.',
      input: {},
      output: { nothing: z.string() },
      annotations: readOnly,
      run: () => refuses('attic is not connected'),
    });
    const client = await connected([asleep]);

    const result = await client.callTool({ name: 'asleep', arguments: {} });

    expect(result.isError).toBe(true);
    expect(result.content).toEqual([{ type: 'text', text: 'attic is not connected' }]);
    // No structured half, which is what the specification asks of an error and
    // what the SDK allows despite the declared output schema.
    expect(result.structuredContent).toBeUndefined();
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
      output: { shouted: z.string() },
      annotations: readOnly,
      run: ({ who }) => answers({ shouted: who.toUpperCase() }),
    });
    const client = await connected([strict]);

    const result = await client.callTool({ name: 'strict', arguments: { who: 7 } });

    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain('expected string');
  });

  it('fills in a default the caller did not name, and holds the cap it published', async () => {
    const bounded = defineMcpTool({
      name: 'bounded',
      description: 'Takes a limit.',
      input: { limit: z.int().min(1).max(10).default(3) },
      output: { limit: z.int() },
      annotations: readOnly,
      run: ({ limit }) => answers({ limit }),
    });
    const client = await connected([bounded]);

    const unasked = await client.callTool({ name: 'bounded', arguments: {} });
    const asked = await client.callTool({ name: 'bounded', arguments: { limit: 9 } });
    const silly = await client.callTool({ name: 'bounded', arguments: { limit: 99 } });

    expect(unasked.structuredContent).toEqual({ limit: 3 });
    expect(asked.structuredContent).toEqual({ limit: 9 });
    // A bound is a bound. It is published in the schema and enforced before the
    // handler, so no tool has to clamp a number of its own.
    expect(silly.isError).toBe(true);
  });

  it('refuses an answer that does not match the shape the tool published', async () => {
    // A projection that drifted from the feature it reads. The published schema
    // is the contract, and breaking it is a failed call here rather than a key
    // quietly missing in somebody's agent.
    const drifted = defineMcpTool({
      name: 'drifted',
      description: 'Answers with the wrong shape.',
      input: {},
      output: { count: z.int() },
      annotations: readOnly,
      // The cast is the point of the test: it is what a drifted projection
      // would have to look like, since nothing that ships is written this way.
      run: () => answers({ count: 'seven' } as unknown as { count: number }),
    });
    const client = await connected([drifted]);

    const result = await client.callTool({ name: 'drifted', arguments: {} });

    expect(result.isError).toBe(true);
  });

  it('carries a tool that takes no arguments', async () => {
    const nothing = defineMcpTool({
      name: 'nothing',
      description: 'Takes no arguments.',
      input: {},
      output: { done: z.boolean() },
      annotations: readOnly,
      run: () => answers({ done: true }),
    });
    const client = await connected([nothing]);

    const { tools } = await client.listTools();
    const result = await client.callTool({ name: 'nothing', arguments: {} });

    expect(tools[0]?.inputSchema).toMatchObject({ type: 'object', properties: {} });
    expect(result.structuredContent).toEqual({ done: true });
  });

  it('reports a handler that threw as a failed call rather than a broken session', async () => {
    // One tool falling over is that tool's problem. A throw that reached the
    // transport would take the connection with it, and every other tool on this
    // endpoint with it.
    const broken = defineMcpTool({
      name: 'broken',
      description: 'Always fails.',
      input: {},
      output: { never: z.string() },
      annotations: readOnly,
      run: (): never => {
        throw new Error('the store is unreadable');
      },
    });
    const client = await connected([broken, greet]);

    const failed = await client.callTool({ name: 'broken', arguments: {} });
    const after = await client.callTool({ name: 'greet', arguments: { who: 'robert' } });

    expect(failed.isError).toBe(true);
    expect(after.structuredContent).toEqual({ greeting: 'hello robert' });
  });

  it('awaits a handler that returns a promise', async () => {
    const slow = defineMcpTool({
      name: 'slow',
      description: 'Answers later.',
      input: {},
      output: { when: z.string() },
      annotations: readOnly,
      run: () => Promise.resolve(answers({ when: 'eventually' })),
    });
    const client = await connected([slow]);

    expect((await client.callTool({ name: 'slow', arguments: {} })).structuredContent).toEqual({
      when: 'eventually',
    });
  });
});
