import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { serverBeaconSchema } from './beacon.js';
import { clientFrameSchema, hubFrameSchema } from './client.js';
import { hubToServerFrameSchema, serverToHubFrameSchema } from './server.js';
import { CLIENT_PROTOCOL_VERSION, SERVER_PROTOCOL_VERSION } from './version.js';

/**
 * The guard that makes "bump the leg in the same commit" something a test can
 * fail on rather than something a reviewer has to remember.
 *
 * Each leg's frames are rendered as JSON Schema and compared with a snapshot
 * file named after that leg's version. Change a shape without bumping and the
 * rendering no longer matches the file for the current number. Bump without
 * committing the new file and there is no file for the new number: vitest
 * writes one locally, where the diff shows it, but under `CI` it writes nothing
 * and fails, so a bump cannot reach master without its snapshot.
 *
 * The rendering is the input side, `io: 'input'`, because that is what a peer
 * may put on the wire; a transform's output is this process's business.
 * `unrepresentable: 'any'` lets a schema JSON Schema cannot say (a refinement's
 * predicate, a transform) render as its representable part instead of
 * throwing, which is also the guard's blind spot: a change inside a `.refine`
 * or `.transform` moves nothing here.
 */
function render(schema: z.ZodType): string {
  return `${JSON.stringify(z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' }), null, 2)}\n`;
}

describe('the wire shape of each protocol leg', () => {
  it('matches the client leg snapshot for CLIENT_PROTOCOL_VERSION', async () => {
    const leg = z.object({ clientFrame: clientFrameSchema, hubFrame: hubFrameSchema });
    await expect(render(leg)).toMatchFileSnapshot(
      `./wire-shape/client-leg.v${String(CLIENT_PROTOCOL_VERSION)}.json`,
    );
  });

  it('matches the server leg snapshot for SERVER_PROTOCOL_VERSION', async () => {
    const leg = z.object({
      hubToServer: hubToServerFrameSchema,
      serverToHub: serverToHubFrameSchema,
      beacon: serverBeaconSchema,
    });
    await expect(render(leg)).toMatchFileSnapshot(
      `./wire-shape/server-leg.v${String(SERVER_PROTOCOL_VERSION)}.json`,
    );
  });
});
