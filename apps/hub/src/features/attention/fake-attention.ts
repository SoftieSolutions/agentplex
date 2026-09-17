import type { SessionRef } from '@agentplex/protocol';
import type { Attention, AttentionOutcome, SessionAttention } from './attention.js';
import { UNATTENDED } from './attention.js';

/**
 * The attention table, in memory, driven by hand.
 *
 * A real implementation of the seam rather than a mock, for the reason the
 * fake session control is one: what a client connection has to get right is
 * what it does with an outcome, and each outcome here is a value this hands
 * back. It keeps the two columns apart exactly as the real one does -- an
 * acknowledgement leaves a mute alone, and the other way round -- so a test
 * that would catch the real feature conflating them catches this one too.
 *
 * What it does not do is a database. The SQL is exercised where it lives,
 * against a migrated schema; this is for the tests whose subject is the socket.
 */
export interface FakeAttention extends Attention {
  /** Every acknowledgement asked for, in order. */
  readonly acknowledged: readonly SessionRef[];
  /** Every mute and unmute asked for, in order. */
  readonly mutes: readonly { readonly ref: SessionRef; readonly muted: boolean }[];
  /** Every ref this fake announced through `onChanged`, in order. */
  readonly announced: readonly SessionRef[];
  /** Makes every later write refuse, for the path where a session is unknown. */
  refuseWith(outcome: Extract<AttentionOutcome, { ok: false }>): void;
  /** Makes every later write succeed again. */
  accept(): void;
}

export interface FakeAttentionOptions {
  /** The moment this fake stamps. A number, because a fake clock is a number. */
  readonly now?: number;
  readonly onChanged?: (ref: SessionRef, attention: SessionAttention) => void;
}

export function createFakeAttention(options: FakeAttentionOptions = {}): FakeAttention {
  const now = options.now ?? 1_000;
  const rows = new Map<string, SessionAttention>();
  const acknowledged: SessionRef[] = [];
  const mutes: { ref: SessionRef; muted: boolean }[] = [];
  const announced: SessionRef[] = [];
  let refusal: Extract<AttentionOutcome, { ok: false }> | null = null;

  const keyOf = (ref: SessionRef): string => JSON.stringify([ref.storeId, ref.sessionId]);

  const write = (ref: SessionRef, attention: SessionAttention): AttentionOutcome => {
    rows.set(keyOf(ref), attention);
    announced.push(ref);
    options.onChanged?.(ref, attention);
    return { ok: true, attention };
  };

  return {
    async load(): Promise<void> {
      for (const [key, attention] of rows) {
        const [storeId, sessionId] = JSON.parse(key) as [
          SessionRef['storeId'],
          SessionRef['sessionId'],
        ];
        announced.push({ storeId, sessionId });
        options.onChanged?.({ storeId, sessionId }, attention);
      }
    },

    async acknowledge(ref: SessionRef): Promise<AttentionOutcome> {
      acknowledged.push(ref);
      if (refusal !== null) return refusal;
      const held = rows.get(keyOf(ref)) ?? UNATTENDED;
      return write(ref, { acknowledgedAt: now, mutedAt: held.mutedAt });
    },

    async setMuted(ref: SessionRef, muted: boolean): Promise<AttentionOutcome> {
      mutes.push({ ref, muted });
      if (refusal !== null) return refusal;
      const held = rows.get(keyOf(ref)) ?? UNATTENDED;
      return write(ref, { acknowledgedAt: held.acknowledgedAt, mutedAt: muted ? now : null });
    },

    refuseWith(outcome: Extract<AttentionOutcome, { ok: false }>): void {
      refusal = outcome;
    },

    accept(): void {
      refusal = null;
    },

    get acknowledged(): readonly SessionRef[] {
      return acknowledged;
    },

    get mutes(): readonly { readonly ref: SessionRef; readonly muted: boolean }[] {
      return mutes;
    },

    get announced(): readonly SessionRef[] {
      return announced;
    },
  };
}
