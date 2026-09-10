import { serverIdSchema } from '@agentplex/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Queryable } from '../hub/db/database.js';
import { loopbackServerAddress, serverAddressSchema } from '../hub/pairing/server-address.js';
import {
  listServers,
  registerServer,
  revokeServer,
  type LiveServerRegistration,
} from '../hub/pairing/server-registrations.js';
import { openMigratedSchema, type MigratedSchema } from '../hub/pairing/test-migrated-schema.js';
import type { Clock, IdGenerator } from '@agentplex/node-shared';
import { recordLocalPairing, type LocalPairing } from './local-pairing.js';

/**
 * The hub's end of the pairing, against the schema the hub reads it back from.
 *
 * The row is the whole point of this ticket, so it is asserted as a row: what a
 * fake would prove is that this file issued the statements this file expects.
 * What matters instead is that a second setup run does not put the same machine
 * on somebody's screen twice, and that a pairing the operator has since changed
 * or revoked is left exactly as they left it.
 */

const ADDRESS = loopbackServerAddress(8081);
const IDENTITY = '/home/dev/.agentplex/server.json';
const TOKEN = 'a-token-a-csprng-produced-for-this-machine';

const PAIRING: LocalPairing = {
  label: 'this machine',
  address: ADDRESS ?? serverAddressSchema.parse('wss://unreachable.example'),
  serverId: serverIdSchema.parse('server-under-test'),
  token: TOKEN,
  identityPath: IDENTITY,
};

const clock: Clock = { now: () => 1_700_000_000_000 };

let ids: IdGenerator;
let schema: MigratedSchema;
let database: Queryable;

beforeEach(async () => {
  let next = 0;
  ids = { newId: () => `registration-${(next += 1)}` };
  schema = await openMigratedSchema('local-pairing');
  database = schema.database;
});

afterEach(async () => {
  await schema.close();
});

async function live(): Promise<readonly LiveServerRegistration[]> {
  const servers = await listServers(database);
  return servers.filter((server): server is LiveServerRegistration => server.token !== null);
}

describe('recordLocalPairing', () => {
  it('writes the pairing the hub dials its own server with', async () => {
    const outcome = await recordLocalPairing(database, ids, clock, PAIRING);

    expect(outcome.kind).toBe('paired');
    expect(await live()).toEqual([
      expect.objectContaining({ address: ADDRESS, token: TOKEN, label: 'this machine' }),
    ]);
  });

  it('leaves one pairing behind when the same run happens twice', async () => {
    // Setup reconciles rather than duplicates, like every other step of it. A
    // second row would put the same machine on the operator's screen twice and
    // have the hub dial it twice.
    await recordLocalPairing(database, ids, clock, PAIRING);
    const again = await recordLocalPairing(database, ids, clock, PAIRING);

    expect(again.kind).toBe('already-paired');
    expect(await live()).toHaveLength(1);
  });

  it('recognises the pairing by the server it names once the hub has met it', async () => {
    // The address can change -- the operator moved the server port -- and the
    // machine is still the machine. A row that has learned this server's id is
    // this server's pairing whatever address it holds.
    const registered = await registerServer(database, ids, clock, {
      label: 'this machine',
      address: serverAddressSchema.parse('wss://box.example:8443'),
      token: TOKEN,
    });
    await database.query('UPDATE servers SET server_id = ? WHERE id = ?', [
      PAIRING.serverId,
      registered.id,
    ]);

    const outcome = await recordLocalPairing(database, ids, clock, PAIRING);

    expect(outcome.kind).toBe('left-alone');
    expect(await live()).toHaveLength(1);
  });

  it('leaves a pairing whose token disagrees alone, and says which file to look in', async () => {
    // The machine is already paired under a token this identity file does not
    // hold. Overwriting would break a pairing the operator made, and inserting a
    // second row would leave a hub dialling one address with two credentials.
    await registerServer(database, ids, clock, {
      label: 'somebody else set this up',
      address: PAIRING.address,
      token: 'the-token-that-pairing-was-made-with',
    });

    const outcome = await recordLocalPairing(database, ids, clock, PAIRING);

    expect(outcome.kind).toBe('left-alone');
    expect(outcome.kind === 'left-alone' ? outcome.problem : '').toContain(IDENTITY);
    expect(await live()).toHaveLength(1);
  });

  it('does not re-pair a machine the operator revoked', async () => {
    // A revoked pairing is a person having said no. Setup writing it back would
    // be the hub choosing, which is the one thing the exception does not cover.
    const registered = await registerServer(database, ids, clock, {
      label: 'this machine',
      address: PAIRING.address,
      token: TOKEN,
    });
    await revokeServer(database, clock, registered.id);

    const outcome = await recordLocalPairing(database, ids, clock, PAIRING);

    expect(outcome.kind).toBe('left-alone');
    expect(await live()).toEqual([]);
  });

  it('never puts the token in what it reports', async () => {
    // Every outcome here is printed. The identity file is named, and what is in
    // it stays in it -- the same rule the server follows when it logs the path.
    const paired = await recordLocalPairing(database, ids, clock, PAIRING);
    const again = await recordLocalPairing(database, ids, clock, PAIRING);

    expect(JSON.stringify([paired, again])).not.toContain(TOKEN);
  });
});
