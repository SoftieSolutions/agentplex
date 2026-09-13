import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type McpTool } from './tool-registry.js';

const anyRecord = z.record(z.string(), z.unknown());
const textBlocks = z.array(z.object({ type: z.literal('text'), text: z.string() }));

/**
 * One tool, called the way a client calls it.
 *
 * Every tool suite in this folder stands on this rather than on `tool.run`
 * directly, and the difference is the thing worth testing: `run` is a function
 * returning an object, while a call goes through the SDK's argument validation,
 * the registry's content block, and -- because `listTools` is asked first --
 * the client's own check of the structured answer against the schema the tool
 * published. A suite that called `run` would pass while the shape a model is
 * handed was wrong.
 *
 * In-memory transports, so there is no port and no HTTP. What crosses a real
 * port is `mcp.integration.test.ts`, once, for the mounting.
 *
 * Test support: `tsconfig.build.json` excludes `test-*.ts`, so this never ships.
 */

/** What one call answered with, as a tool suite reads it. */
export interface ToolCall {
  /** The structured half, or `undefined` on a refusal, which carries none. */
  readonly structured: Record<string, unknown> | undefined;
  /** The one text block: the answer rendered, or the refusal's sentence. */
  readonly text: string;
  readonly isError: boolean;
}

export async function callTool(
  tool: McpTool,
  args: Record<string, unknown> = {},
): Promise<ToolCall> {
  const server = new McpServer({ name: 'agentplex-hub', version: '0.0.0' });
  registerTool(server, tool);

  const [clientEnd, serverEnd] = InMemoryTransport.createLinkedPair();
  await server.connect(serverEnd);

  const client = new Client({ name: 'tool-call', version: '0.0.0' });
  await client.connect(clientEnd);

  try {
    // Before the call, and that is the point: the client caches a tool's output
    // schema from the listing and validates the answer against it. Without this
    // line the structured half would be taken on trust.
    await client.listTools();
    const result = await client.callTool({ name: tool.name, arguments: args });
    const blocks = textBlocks.safeParse(result.content);
    // Parsed rather than asserted, both of them. The SDK types a result's
    // content and structured half loosely -- a refusal genuinely has no
    // structured half -- and a suite that cast would be asserting against a
    // shape it had told itself was there.
    const structured = anyRecord.safeParse(result.structuredContent);
    return {
      structured: structured.success ? structured.data : undefined,
      text: blocks.success ? blocks.data.map((block) => block.text).join('') : '',
      isError: result.isError === true,
    };
  } finally {
    await client.close();
  }
}
