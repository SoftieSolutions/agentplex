import { PROTOCOL_VERSION, type HubId } from '@agentplex/protocol';
import { defineMcpTool, type McpTool } from './tool-registry.js';

/**
 * The one tool this build ships with.
 *
 * It exists so the endpoint is a thing that can be driven end to end before
 * there is anything worth driving it for: a client that can initialize, list
 * this and call it has proved the transport, the bearer gate and the registry
 * in one round trip. AGX-43, AGX-44 and AGX-244 add the tools that do work.
 *
 * It grants nothing. Both facts it returns are already in the `welcome` frame
 * every attached client is sent before it has asked for anything, so a caller
 * holding the client token learns from this exactly what the screen in front of
 * them already displays. That is the bar every tool added after it has to clear.
 */
export function hubInfoTool({ hubId }: { readonly hubId: HubId }): McpTool {
  return defineMcpTool({
    name: 'hub_info',
    description:
      'Identifies this hub: its id, and the protocol version it speaks to servers and clients.',
    input: {},
    // JSON as text rather than a structured result. Two facts do not earn a
    // second schema to keep in step with the first, and every MCP client can
    // read this without having been told about it.
    run: () => JSON.stringify({ hubId, protocolVersion: PROTOCOL_VERSION }),
  });
}
