/**
 * The end of an exhaustive switch.
 *
 * A frame union grows, and the switch that routes it has to grow with it. The
 * failure mode is not a crash but a silence: a frame the parser accepts and no
 * case names falls out of the bottom of the switch and vanishes, which is how
 * the hub came to parse the terminal frames and relay none of them. Assigning
 * the leftover to `never` turns that into a type error on the line that
 * forgot, and the throw is for the value a type could not see -- a peer whose
 * protocol number matched and whose frames did not.
 */
export function assertNever(value: never, what: string): never {
  throw new Error(`${what}: unhandled ${JSON.stringify(value)}`);
}
