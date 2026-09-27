import { createContext, useContext, useSyncExternalStore, type JSX, type ReactNode } from 'react';
import type { MockSwitch } from './mock-switch.js';

/**
 * The mock switch, handed to every screen through context.
 *
 * Context rather than a prop threaded like the dismissal: the dismissal has
 * one reader, the gate in App.tsx, while sample data is asked for by leaves
 * of every feature tree -- a graph card, a notification row, a machine line --
 * and a prop through every screen between them would be a parameter most of
 * them only pass along. The switch itself is still built once, in main.tsx,
 * and handed to App like the other stores; this only carries it down.
 *
 * With no provider the answer is off, not an error: a screen drawn on its own
 * in a test, or anywhere the provider is missing, draws what the state
 * carries and nothing invented.
 */
const MockModeContext = createContext<MockSwitch | null>(null);

export function MockModeProvider({
  mock,
  children,
}: {
  readonly mock: MockSwitch;
  readonly children: ReactNode;
}): JSX.Element {
  return <MockModeContext value={mock}>{children}</MockModeContext>;
}

/** Nothing to subscribe to without a switch; the unsubscribe does nothing. */
function subscribeToNothing(): () => void {
  return () => {};
}

function off(): boolean {
  return false;
}

/**
 * True while sample data is to be shown. Read through
 * `useSyncExternalStore`, so flipping the switch re-renders every reader in
 * place with no effect mirroring it into state.
 */
export function useMockMode(): boolean {
  const mock = useContext(MockModeContext);
  return useSyncExternalStore(mock?.subscribe ?? subscribeToNothing, mock?.read ?? off);
}

/**
 * The switch itself, for the one control that flips it (Settings, Developer).
 * Null with no provider, in which case there is nothing to flip.
 */
export function useMockSwitch(): MockSwitch | null {
  return useContext(MockModeContext);
}
