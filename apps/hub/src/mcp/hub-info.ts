import { CLIENT_PROTOCOL_VERSION, SERVER_PROTOCOL_VERSION, type HubId } from '@agentplex/protocol';
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
 * It grants nothing. The id and the client leg are already in the `welcome`
 * frame every attached client is sent before it has asked for anything, and the
 * server leg is compiled into the web build, which the install checks hold
 * equal to this hub's. A caller holding the client token learns from this
 * exactly what the screen in front of them already knows. That is the bar every
 * tool added after it has to clear.
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
      'Identifies this hub: its id, and the protocol version it speaks on each leg, to clients and to servers.',
    input: {},
    output: {
      hubId: z.string().describe('This hub, as every server and client names it.'),
      clientProtocolVersion: z
        .int()
        .describe(
          'The wire contract this hub speaks to clients, not the version of the build it came from.',
        ),
      serverProtocolVersion: z
        .int()
        .describe(
          'The wire contract this hub speaks to servers, not the version of the build it came from.',
        ),
    },
    annotations: readOnly,
    run: () =>
      answers({
        hubId,
        clientProtocolVersion: CLIENT_PROTOCOL_VERSION,
        serverProtocolVersion: SERVER_PROTOCOL_VERSION,
      }),
  });
}
