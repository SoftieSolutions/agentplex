import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

/**
 * What a tool is, and the one place one becomes something the SDK will serve.
 *
 * The rule this file exists to keep is the one the endpoint is allowed to make
 * a claim about: **MCP gains no capability the UI lacks, and there is no
 * generic-command tool, ever.** A tool is a named, described, schema'd thing
 * that calls a hub feature the client socket can already reach. It is not a
 * place to pass an argv, an operation name, an env var or a cwd -- those go
 * through the operation registry in `@agentplex/providers` and nowhere else --
 * and a tool that took one would be this hub growing a shell that the screen a
 * user is looking at does not have.
 *
 * The seam is deliberately four things and no more: a name, a description, a
 * zod shape, and a handler returning text. Everything that makes an MCP tool
 * awkward to write lives here once -- the shape-to-JSON-Schema conversion, the
 * content block, the await -- so a tool file is the feature call and nothing
 * else.
 *
 * It is not on `mcp.ts`. The entry file is what another *feature* may reach,
 * and a tool is not that: tools are written in this folder, against other
 * features' entry files, because MCP adds no frames and calls those features
 * directly in this process. Putting the vocabulary here also keeps the import
 * graph a line rather than a ring -- `mcp.ts` builds the tools, so a tool that
 * imported its own type from `mcp.ts` would be a cycle.
 */

/**
 * The arguments a tool takes, as zod.
 *
 * A shape rather than a `z.object`, because that is what the SDK turns into the
 * JSON Schema a model reads: it names the properties, and `describe()` on any
 * of them becomes that property's documentation. An object schema would work
 * and would hide the shape one layer down, where a tool author cannot see that
 * it is the thing on show.
 */
export type McpToolInput = Record<string, z.ZodType>;

/**
 * A tool, with its argument type already checked against its own schema.
 *
 * Erased on purpose. A list of tools is heterogeneous -- every one of them has a
 * different argument type -- and a generic that survived into the list would
 * make the list unwritable. `defineMcpTool` is where the two are tied together,
 * and it is the only way to make one of these.
 */
export interface McpTool {
  /** Snake case, which is what every MCP client's tool listing is written in. */
  readonly name: string;
  /** One sentence. It is what a model reads to decide whether to call this. */
  readonly description: string;
  readonly input: McpToolInput;
  /** The text an MCP client is handed. */
  run(args: unknown): Promise<string>;
}

export interface McpToolDefinition<Input extends McpToolInput> {
  readonly name: string;
  readonly description: string;
  readonly input: Input;
  run(args: z.infer<z.ZodObject<Input>>): Promise<string> | string;
}

/**
 * Declares a tool.
 *
 * The parse inside is not belt and braces over nothing. The SDK validates the
 * arguments against this same shape before it calls anything, and this parses
 * them again on the way into the handler -- two independent checks, so that the
 * handler's parameter type is a fact about this file rather than a promise
 * about a dependency's behaviour. Casting instead would be the one line that
 * makes every tool's signature a claim, and the objects are a few fields wide.
 */
export function defineMcpTool<Input extends McpToolInput>({
  name,
  description,
  input,
  run,
}: McpToolDefinition<Input>): McpTool {
  const schema = z.object(input);
  return {
    name,
    description,
    input,
    run: async (args: unknown): Promise<string> => run(schema.parse(args)),
  };
}

/**
 * Puts one tool onto a server.
 *
 * Every tool answers in one text block. Structured output is a thing MCP has
 * and this hub deliberately does not use yet: a second shape per tool is a
 * second thing to keep in step with the first, and nothing that has been asked
 * for needs it. A tool that wants structure emits JSON as its text, which every
 * client can read and no client has to have been told about.
 */
export function registerTool(server: McpServer, tool: McpTool): void {
  server.registerTool(
    tool.name,
    { description: tool.description, inputSchema: tool.input },
    async (args: unknown) => ({ content: [{ type: 'text' as const, text: await tool.run(args) }] }),
  );
}
