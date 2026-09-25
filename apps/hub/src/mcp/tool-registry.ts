import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
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
 * The seam is deliberately small -- a name, a description, two zod shapes, an
 * annotation and a handler -- and everything that makes an MCP tool awkward to
 * write lives here once: the shape-to-JSON-Schema conversion on both sides, the
 * content block, the structured result, the refusal, the await. A tool file is
 * the feature call and nothing else.
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
 * What a tool answers with, as zod, in exactly the same form and for exactly
 * the same reason.
 *
 * AGX-42 shipped without this and said why: "a second shape per tool is a
 * second thing to keep in step with the first". That argument held while the
 * only tool returned two scalars. It stops holding here, where a tool answers
 * with a list of session rows, and it stops holding for a reason worth writing
 * down: the text block and the structured object are **not** two things kept in
 * step. `defineMcpTool` below derives the text from the structured value, so a
 * tool author produces one object, and what a client reads as prose and what it
 * reads as data cannot disagree.
 *
 * What the schema buys is the half a tool author cannot check by reading their
 * own file. A model told the shape of an answer can pick a field out of it
 * without parsing English, and the SDK refuses a result that does not match the
 * shape this declared -- so a field renamed in a feature is a failed call here
 * rather than a silently absent key in somebody's agent.
 */
export type McpToolOutput = Record<string, z.ZodType>;

/**
 * A tool's answer: the value, or the sentence saying why there is none.
 *
 * The same shape `StreamOutcome` has on the server leg, deliberately, because
 * it is the same fact: a feature refuses in words, and the words are the
 * answer. **A refusal is never a throw.** A server that is not connected, a
 * session nobody reports, a subscription the holder declined -- each of those
 * is something an agent can read and act on, and each arrives at an MCP client
 * as `isError: true` carrying the feature's own sentence. A throw would arrive
 * as the first line of a stack wrapped in a JSON-RPC error, which is the same
 * call failing with the reason taken out.
 */
export type McpAnswer<Value> =
  { readonly ok: true; readonly value: Value } | { readonly ok: false; readonly problem: string };

/** The answer a tool found. */
export function answers<Value>(value: Value): McpAnswer<Value> {
  return { ok: true, value };
}

/**
 * The sentence a tool refuses with.
 *
 * `McpAnswer<never>`, which is assignable to any `McpAnswer<Value>`: refusing
 * says nothing about the type of the answer that was not produced.
 */
export function refuses(problem: string): McpAnswer<never> {
  return { ok: false, problem };
}

/** What one successful call becomes on the wire: one text block, one object. */
export interface McpToolAnswer {
  readonly text: string;
  readonly structured: Record<string, unknown>;
}

/**
 * A tool, with its argument and answer types already checked against its own
 * schemas.
 *
 * Erased on purpose. A list of tools is heterogeneous -- every one of them has a
 * different argument type and a different answer type -- and a generic that
 * survived into the list would make the list unwritable. `defineMcpTool` is
 * where the shapes and the handler are tied together, and it is the only way to
 * make one of these.
 */
export interface McpTool {
  /** Snake case, which is what every MCP client's tool listing is written in. */
  readonly name: string;
  /** One sentence. It is what a model reads to decide whether to call this. */
  readonly description: string;
  readonly input: McpToolInput;
  readonly output: McpToolOutput;
  /**
   * What this tool does to the world, as the protocol's own hints.
   *
   * Required rather than optional, so that a tool author has to state it. It
   * is the one field a client reads before deciding whether to ask a person
   * first, and the three constants below are the whole vocabulary this hub has.
   */
  readonly annotations: ToolAnnotations;
  run(args: unknown): Promise<McpAnswer<McpToolAnswer>>;
}

/**
 * A tool that only reads.
 *
 * `destructiveHint` and `idempotentHint` are absent rather than set, and that
 * is the specification's own rule: both are meaningful only when
 * `readOnlyHint` is false, and a field that means nothing is still a field a
 * reader can be misled by.
 */
export const readOnly: ToolAnnotations = { readOnlyHint: true };

/**
 * A tool that changes something, and nothing it changes was there before.
 *
 * Starting a session and typing into one: both alter the world and neither
 * takes anything away, which is exactly what `destructiveHint: false` says. It
 * is stated rather than left off because with `readOnlyHint: false` the field
 * has a meaning and a default -- the specification's default is `true` -- so
 * silence here would tell a client that these tools destroy things.
 *
 * `idempotentHint: false` for the same reason it is honest: calling either of
 * these twice does it twice. Two starts are two agents, and a prompt sent again
 * is a prompt typed again.
 */
export const acts: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
};

/**
 * A tool that ends something somebody may be in the middle of.
 *
 * Stopping a session kills a process that was working, and the transcript it
 * leaves behind is not the work it was doing. The hub refuses a stop aimed at a
 * busy holder -- `session-routing.ts` carries that argument -- and this is the
 * half of it a client can act on before the call is made, which is the whole
 * point of the hint: a client that asks a person first should be asking here.
 *
 * Not idempotent either. A second stop of a session that has since been started
 * again would stop that one, and a client told otherwise might retry a call it
 * only thought had failed.
 */
export const destroys: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
};

export interface McpToolDefinition<Input extends McpToolInput, Output extends McpToolOutput> {
  readonly name: string;
  readonly description: string;
  readonly input: Input;
  readonly output: Output;
  readonly annotations: ToolAnnotations;
  run(
    args: z.infer<z.ZodObject<Input>>,
  ): Promise<McpAnswer<z.infer<z.ZodObject<Output>>>> | McpAnswer<z.infer<z.ZodObject<Output>>>;
  /**
   * What the text block says, when JSON of the answer is the wrong thing to
   * show.
   *
   * Absent for every tool whose answer is a record: JSON is what a model reads
   * best, and it is derived from the same object the structured result is, so
   * there is nothing to keep in step. It exists for the one tool whose answer
   * *is* text -- `read_terminal` -- where escaping a terminal's own output into
   * a JSON string hands a reader back the thing it asked for, quoted.
   */
  render?(value: z.infer<z.ZodObject<Output>>): string;
}

/**
 * Declares a tool.
 *
 * The parses inside are not belt and braces over nothing, and there are two of
 * them now.
 *
 * Inbound: the SDK validates the arguments against this same shape before it
 * calls anything, and this parses them again on the way into the handler -- two
 * independent checks, so that the handler's parameter type is a fact about this
 * file rather than a promise about a dependency's behaviour.
 *
 * Outbound: the answer is parsed against the declared output shape before it
 * becomes either the text or the structured result. The SDK validates it too,
 * and would refuse a mismatch as a failed call -- but it would refuse it in its
 * own words, after the tool had already decided what to say. Parsing here means
 * the object a client is handed is the object this shape describes, and a
 * projection that drifted from a feature's type is caught by this repository's
 * own tests rather than in somebody's agent.
 *
 * Casting instead, in either direction, would be the one line that makes every
 * tool's signature a claim. The objects are a few fields wide.
 */
export function defineMcpTool<Input extends McpToolInput, Output extends McpToolOutput>({
  name,
  description,
  input,
  output,
  annotations,
  run,
  render,
}: McpToolDefinition<Input, Output>): McpTool {
  const takes = z.object(input);
  const gives = z.object(output);

  return {
    name,
    description,
    input,
    output,
    annotations,
    run: async (given: unknown): Promise<McpAnswer<McpToolAnswer>> => {
      const answered = await run(takes.parse(given));
      if (!answered.ok) return answered;

      const parsed = gives.parse(answered.value);
      const structured: Record<string, unknown> = parsed;
      return {
        ok: true,
        value: {
          text: render === undefined ? JSON.stringify(structured) : render(parsed),
          structured,
        },
      };
    },
  };
}

/**
 * Puts one tool onto a server.
 *
 * A refusal becomes `isError: true` with the feature's sentence and no
 * structured result, which is what the specification asks for and what the SDK
 * checks: a result answering a tool that declared an output schema must carry a
 * structured value *unless* it is an error. So the one shape a refusal has is
 * the one shape it is allowed to have, and a client reading only the text block
 * still gets the whole reason.
 */
export function registerTool(server: McpServer, tool: McpTool): void {
  server.registerTool(
    tool.name,
    {
      description: tool.description,
      inputSchema: tool.input,
      outputSchema: tool.output,
      annotations: tool.annotations,
    },
    async (args: unknown) => {
      const answered = await tool.run(args);
      if (!answered.ok) {
        return { content: [{ type: 'text' as const, text: answered.problem }], isError: true };
      }
      return {
        content: [{ type: 'text' as const, text: answered.value.text }],
        structuredContent: answered.value.structured,
      };
    },
  );
}
