import {
  checkProtocolVersion,
  serverAddressSchema,
  serverLabelSchema,
  serverTokenSchema,
  SERVER_LABEL_MAX_CHARS,
  type MachineState,
  type ServerAddress,
  type ServerCandidate,
} from '@agentplex/protocol';

/**
 * What the pairing form collects and how it is checked before anything is
 * submitted. Pairing is always the user typing that server's token into the
 * hub: a name for the row, the address the hub will dial, and the token out
 * of that server's identity file. Nothing prints that token -- it is read
 * off disk on the machine that owns it -- so the message that asks for one
 * says where it is rather than sending somebody hunting through a log.
 *
 * Every rule here is the protocol's, applied to what was typed. This file used
 * to carry its own copy of the address rules, with a header saying they
 * mirrored the hub's and had to be kept in step by hand; they are one parser
 * now, in the package both ends share, because an address is on the wire in
 * both directions. What the form still does is run it before anything is sent,
 * so the user hears "no" from the field they typed rather than from a round
 * trip.
 */

export interface PairingFormInput {
  readonly name: string;
  readonly address: string;
  readonly token: string;
}

/** One problem per field, in words, or absent when the field is fine. */
export interface PairingFormProblems {
  readonly name?: string;
  readonly address?: string;
  readonly token?: string;
}

/**
 * What a checked form submits. The same shape the hub's pairing table takes.
 *
 * `address` keeps the brand the protocol's parser puts on it, so nothing can
 * reach `pairServer` with an address that has not been through it. The label
 * and the token are plain strings: what makes one of those acceptable is a
 * bound, not a shape, and there is nothing downstream that could be misled by
 * one that is merely short.
 */
export interface PairingRequest {
  readonly label: string;
  readonly address: ServerAddress;
  readonly token: string;
}

export type PairingFormResult =
  | { readonly ok: true; readonly request: PairingRequest }
  | { readonly ok: false; readonly problems: PairingFormProblems };

/**
 * Checks the whole form at once, so the user is told every problem in one
 * pass rather than fixing them serially against a form that reveals one "no"
 * at a time.
 *
 * The sentences for the address are the protocol parser's own, because they
 * were written to be read by whoever typed one and that is exactly who is
 * looking at this field. The other two are this form's, for the same reason in
 * reverse: "expected a string of at least 1 character" is what a schema says,
 * and it is not what a person needs to be told about an empty box.
 */
export function parsePairingForm(input: PairingFormInput): PairingFormResult {
  const problems: { name?: string; address?: string; token?: string } = {};

  const name = serverLabelSchema.safeParse(input.name);
  if (!name.success) {
    problems.name =
      input.name.trim().length === 0
        ? 'expected a name for this server'
        : `expected a name of at most ${String(SERVER_LABEL_MAX_CHARS)} characters`;
  }

  const address = serverAddressSchema.safeParse(input.address);
  if (!address.success) {
    problems.address = address.error.issues.map((issue) => issue.message).join('; ');
  }

  const token = serverTokenSchema.safeParse(input.token);
  if (!token.success) problems.token = "expected the token in that server's identity file";

  if (!name.success || !address.success || !token.success) return { ok: false, problems };
  return { ok: true, request: { label: name.data, address: address.data, token: token.data } };
}

/**
 * A server the hub has heard announce itself on the network: a candidate, not
 * a pairing. The shape deliberately has no token field — a beacon never
 * carries one, and a candidate that could pre-fill a token would be trust
 * arriving from the network instead of from the user.
 */
export interface DiscoveredCandidate {
  /** What the beacon says the machine calls itself. Shown, never trusted. */
  readonly serverId: string;
  /** The address the beacon named, exactly as it named it. */
  readonly host: string;
  readonly port: number;
  /** The protocol that machine claimed to speak. */
  readonly protocolVersion: number;
  /**
   * The `wss://` address selecting this candidate would put in the form, or
   * `null` when no dialable one can be built from what was announced.
   */
  readonly address: string | null;
  /**
   * Why this cannot be paired from here, in words, or `null` when it can.
   *
   * A reason rather than a boolean, because the two ways to be unusable lead
   * different places: one is a version and somebody has to upgrade something,
   * the other is an address nothing can dial. Both are shown rather than
   * hidden — a machine that is there and unreachable is a different report
   * from an empty network, and the empty one would be untrue.
   */
  readonly unusable: string | null;
}

/**
 * What selecting a candidate does to the form: it pre-fills the address and
 * stops. The return type is the rule — there is no token here to hand over,
 * and no name either: the beacon's self-description is a hint on the list, not
 * a value typed into the user's form on their behalf.
 *
 * `null` for a candidate that is unusable, so the refusal lives in the function
 * rather than only in whatever draws the list. Both reasons land here: an
 * address nothing can dial has nothing to offer, and a machine speaking
 * another protocol would make a pairing that is refused at the handshake and
 * sits in the list unreachable forever. The user can still type either address
 * by hand — nothing here forbids anything — but a shortcut whose destination
 * this build already knows is broken is a suggestion that should not be made.
 */
export function prefillFromCandidate(
  candidate: DiscoveredCandidate,
): { readonly address: string } | null {
  if (candidate.unusable !== null || candidate.address === null) return null;
  return { address: candidate.address };
}

/**
 * The candidates the hub has heard, read out of the machine state.
 *
 * They arrive in their own field, never mixed into `servers`, and this reader
 * keeps them apart on the way in as well: nothing here looks at a paired
 * server, so no amount of broadcasting can make one appear in this list.
 *
 * The version verdict is reached here rather than read off the frame. The hub
 * publishes what the beacon claimed and no boolean beside it, because a client
 * reading a machine state has already had its own `hello` compared with `===`
 * against that hub's `PROTOCOL_VERSION` — so the number this build compares
 * against is the number the hub would have compared against, and a field
 * carrying the answer could only ever be a second copy free to disagree.
 */
export function discoveredCandidates(state: MachineState | null): readonly DiscoveredCandidate[] {
  if (state === null) return [];
  return state.candidates.map(toCandidate);
}

function toCandidate(candidate: ServerCandidate): DiscoveredCandidate {
  const address = dialableAddress(candidate.address, candidate.port);
  return {
    serverId: candidate.serverId,
    host: candidate.address,
    port: candidate.port,
    protocolVersion: candidate.protocolVersion,
    address,
    unusable: unusableBecause(candidate, address),
  };
}

/**
 * The version is asked first, because it is the answer that survives fixing
 * the other one: an address somebody could retype by hand still leads to a
 * machine this build cannot speak to.
 */
function unusableBecause(candidate: ServerCandidate, address: string | null): string | null {
  const mismatch = checkProtocolVersion(candidate.protocolVersion);
  if (mismatch !== null) {
    return `this hub speaks protocol ${String(mismatch.expected)} and that machine speaks ${String(mismatch.received)}`;
  }
  if (address === null) {
    return 'the address this machine announced is not one that can be dialled';
  }
  return null;
}

/**
 * The announced host and port as an address the pairing form would accept, or
 * `null` when they cannot make one.
 *
 * Run through the form's own parser rather than trusted for being assembled
 * here: what went into it is a string off the network, and a candidate that
 * pre-filled something the form then refused would be a suggestion that breaks
 * at the moment it is acted on. An IPv6 literal is bracketed first, because
 * `wss://fd00::1:8443` is not the address anybody meant and no URL parser will
 * read it as one.
 */
function dialableAddress(host: string, port: number): string | null {
  const authority = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
  const parsed = serverAddressSchema.safeParse(`wss://${authority}:${String(port)}`);
  return parsed.success ? parsed.data : null;
}
