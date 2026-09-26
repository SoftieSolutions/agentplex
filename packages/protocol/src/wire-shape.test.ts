import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { serverBeaconSchema } from './beacon.js';
import { clientFrameSchema, hubFrameSchema } from './client.js';
import { hubToServerFrameSchema, serverToHubFrameSchema } from './server.js';
import { CLIENT_PROTOCOL_VERSION, SERVER_PROTOCOL_VERSION } from './version.js';

/**
 * Vite's `import.meta.glob`, which vitest resolves when it transforms this
 * file. Declared here because this package's types are a browser bundle's and
 * a service's, not vite's; the one call below is the only use.
 */
declare global {
  interface ImportMeta {
    glob(pattern: string): Record<string, () => Promise<unknown>>;
  }
}

/**
 * The guard that makes "bump the leg in the same commit" something a test can
 * fail on rather than something a reviewer has to remember.
 *
 * Each leg's frames are rendered as JSON Schema and compared with a snapshot
 * file named after that leg's version. Change a shape without bumping and the
 * rendering no longer matches the file for the current number.
 *
 * Bump without committing the new file and there is no file for the new
 * number. Vitest alone would write one and pass everywhere `CI` is unset --
 * which includes the check containers, where passing `CI` in also makes pnpm
 * write its store and trips the write guard. So the test asks for itself
 * whether the file was there before the run: `COMMITTED` is the set of
 * snapshots vite found when it transformed this file, before any test wrote
 * one. The first run after a bump writes the new file and still fails, naming
 * it; the file is then committed and the next run passes. No `CI` is needed and
 * no Node builtin, which this package may not import.
 *
 * The rendering is the input side, `io: 'input'`, because that is what a peer
 * may put on the wire; a transform's output is this process's business.
 * `unrepresentable: 'any'` lets a schema JSON Schema cannot say (a refinement's
 * predicate, a transform) render as its representable part instead of
 * throwing, which is also the guard's blind spot: a change inside a `.refine`
 * or `.transform` moves nothing here.
 */
const COMMITTED: ReadonlySet<string> = new Set(
  Object.keys(import.meta.glob('./wire-shape/*.json')),
);

function render(schema: z.ZodType): string {
  return `${JSON.stringify(z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' }), null, 2)}\n`;
}

async function expectCommittedSnapshot(schema: z.ZodType, path: string): Promise<void> {
  await expect(render(schema)).toMatchFileSnapshot(path);
  expect(
    COMMITTED.has(path),
    `${path} was not there before this run: a protocol bump needs its snapshot committed with it`,
  ).toBe(true);
}

describe('the wire shape of each protocol leg', () => {
  it('matches the client leg snapshot for CLIENT_PROTOCOL_VERSION', async () => {
    await expectCommittedSnapshot(
      z.object({ clientFrame: clientFrameSchema, hubFrame: hubFrameSchema }),
      `./wire-shape/client-leg.v${String(CLIENT_PROTOCOL_VERSION)}.json`,
    );
  });

  it('matches the server leg snapshot for SERVER_PROTOCOL_VERSION', async () => {
    await expectCommittedSnapshot(
      z.object({
        hubToServer: hubToServerFrameSchema,
        serverToHub: serverToHubFrameSchema,
        beacon: serverBeaconSchema,
      }),
      `./wire-shape/server-leg.v${String(SERVER_PROTOCOL_VERSION)}.json`,
    );
  });
});
