import { describe, expect, it } from 'vitest';
import { createLogger } from '@agentplex/node-shared';
import type { ServerToHubFrame, StoreId } from '@agentplex/protocol';
import type { GrantId } from '@agentplex/providers';
import { createHubAudience, type HubMember } from './hub-audience.js';
import { createFakeSessionController } from './fake-session-controller.js';

const logger = createLogger('error', () => {});
const STORE = 'store-a' as StoreId;

function member(connectionId: string, grantId: string) {
  const sent: ServerToHubFrame[] = [];
  const closed: string[] = [];
  const value: HubMember = {
    connectionId,
    grantId: grantId as GrantId,
    send: (frame) => void sent.push(frame),
    close: (reason) => void closed.push(reason),
  };
  return { member: value, sent, closed };
}

function sessions(sessionIds: readonly string[] = []) {
  return createFakeSessionController({
    reports: [
      {
        storeId: STORE,
        sessions: [],
        holding: sessionIds.map((sessionId) => ({
          sessionId: sessionId as never,
          stoppable: true,
        })),
      },
    ],
  });
}

describe('createHubAudience', () => {
  it('sends one store report to every connected hub', async () => {
    const audience = createHubAudience({ sessions: sessions(['session-a']), logger });
    const first = member('connection-1', 'grant-1');
    const second = member('connection-2', 'grant-2');
    audience.join(first.member);
    audience.join(second.member);

    await audience.reportToAll(STORE);

    expect(first.sent).toEqual(second.sent);
    expect(first.sent[0]).toMatchObject({ type: 'store-report', storeId: STORE });
  });

  /**
   * The point of the whole file. A hub whose session another hub stopped has
   * asked nothing, so there is no frame to reply to; a whole store report is
   * the fact rather than the answer, and it is what tells it.
   */
  it('reaches the hub that asked for nothing', async () => {
    const controller = sessions(['session-a']);
    const audience = createHubAudience({ sessions: controller, logger });
    const bystander = member('connection-2', 'grant-2');
    audience.join(member('connection-1', 'grant-1').member);
    audience.join(bystander.member);

    await audience.reportToAll(STORE);

    expect(bystander.sent).toHaveLength(1);
  });

  it('scans the store once however many hubs are connected', async () => {
    const controller = sessions();
    const audience = createHubAudience({ sessions: controller, logger });
    for (const id of ['1', '2', '3'])
      audience.join(member(`connection-${id}`, `grant-${id}`).member);

    await audience.reportToAll(STORE);

    expect(controller.scans).toEqual([STORE]);
  });

  it('sends a newly connected hub its own report and nobody else theirs', async () => {
    const audience = createHubAudience({ sessions: sessions(), logger });
    const existing = member('connection-1', 'grant-1');
    const arriving = member('connection-2', 'grant-2');
    audience.join(existing.member);
    audience.join(arriving.member);

    await audience.reportTo(arriving.member, STORE);

    expect(arriving.sent).toHaveLength(1);
    expect(existing.sent).toHaveLength(0);
  });

  it('sends nothing about a store this server does not have', async () => {
    const audience = createHubAudience({ sessions: createFakeSessionController(), logger });
    const only = member('connection-1', 'grant-1');
    audience.join(only.member);

    await audience.reportToAll(STORE);

    expect(only.sent).toHaveLength(0);
  });

  it('sends nothing to a hub that left while the store was being scanned', async () => {
    const audience = createHubAudience({ sessions: sessions(), logger });
    const leaving = member('connection-1', 'grant-1');
    const leave = audience.join(leaving.member);

    const reporting = audience.reportToAll(STORE);
    leave();
    await reporting;

    expect(leaving.sent).toHaveLength(0);
  });

  describe('revocation', () => {
    it('closes every connection one grant holds, and no others', () => {
      const audience = createHubAudience({ sessions: sessions(), logger });
      // One grant, two sockets: a hub that reconnected before the old one had
      // finished closing is two connections and one pairing.
      const first = member('connection-1', 'grant-doomed');
      const second = member('connection-2', 'grant-doomed');
      const other = member('connection-3', 'grant-fine');
      for (const one of [first, second, other]) audience.join(one.member);

      expect(audience.disconnect('grant-doomed' as GrantId, 'this grant was revoked')).toBe(2);

      expect(first.closed).toEqual(['this grant was revoked']);
      expect(second.closed).toEqual(['this grant was revoked']);
      expect(other.closed).toEqual([]);
    });

    it('closes nothing for a grant nothing is connected with', () => {
      const audience = createHubAudience({ sessions: sessions(), logger });
      audience.join(member('connection-1', 'grant-fine').member);

      expect(audience.disconnect('grant-nobody-holds' as GrantId, 'gone')).toBe(0);
    });

    it('names each live grant once, however many connections hold it', () => {
      const audience = createHubAudience({ sessions: sessions(), logger });
      audience.join(member('connection-1', 'grant-a').member);
      audience.join(member('connection-2', 'grant-a').member);
      audience.join(member('connection-3', 'grant-b').member);

      expect(audience.grants).toEqual(['grant-a', 'grant-b']);
    });
  });

  describe('leaving', () => {
    /**
     * A socket that closed is a watcher that is gone, and it is not there to
     * call the detach it was handed. This callback is what the server hangs the
     * terminal manager's `release` on.
     */
    it('tells whoever is listening which connection left', () => {
      const left: string[] = [];
      const audience = createHubAudience({
        sessions: sessions(),
        logger,
        onLeave: (one) => void left.push(one.connectionId),
      });
      const leave = audience.join(member('connection-1', 'grant-1').member);

      leave();
      leave();

      expect(left).toEqual(['connection-1']);
      expect(audience.grants).toEqual([]);
    });
  });
});
