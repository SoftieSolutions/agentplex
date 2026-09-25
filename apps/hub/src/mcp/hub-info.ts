import { PROTOCOL_VERSION, type HubId } from '@agentplex/protocol';
import { z } from 'zod';
import { answers, defineMcpTool, readOnly, type McpTool } from './tool-registry.js';

/**
 * The tool that grants nothing.
 *
 * It exists so the endpoint is a thing that can be driven end to end before
 * there is anything worth driving it for: a client that can initialize, list
 * this and call it has proved the transport, the bearer gate and the registry
 * in one round trip. AGX-43 added the tools that read the fleet; AGX-44 adds
 * the ones that act on it.
 *
 * It grants nothing. Both facts it returns are already in the `welcome` frame
 * every attached client is sent before it has asked for anything, so a caller
 * holding the client token learns from this exactly what the screen in front of
 * them already displays. That is the bar every tool added after it has to clear.
 *
 * It gained an output schema with AGX-43. AGX-42 argued that two facts do not
 * earn a second shape to keep in step with the first, and the registry has
 * since taken away the thing that argument was about: the text block is derived
 * from the structured value, so declaring the shape adds a schema a model can
 * read and nothing that can drift.
 */
export function hubInfoTool({ hubId }: { readonly hubId: HubId }): McpTool {
  return defineMcpTool({
    name: 'hub_info',
    description:
      'Identifies this hub: its id, and the protocol version it speaks to servers and clients.',
    input: {},
    output: {
      hubId: z.string().describe('This hub, as every server and client names it.'),
      protocolVersion: z
        .int()
        .describe('The wire contract this hub speaks, not the version of the build it came from.'),
    },
    annotations: readOnly,
    run: () => answers({ hubId, protocolVersion: PROTOCOL_VERSION }),
  });
}
