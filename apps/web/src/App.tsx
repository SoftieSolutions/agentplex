import { PROTOCOL_VERSION } from '@agentplex/protocol';

/**
 * The scaffold's placeholder. It imports the protocol package so that the
 * dependency the workspace boundaries allow is real from the first commit.
 * The session list, terminal pane and layout tree arrive in milestone 4.
 */
export function App(): React.JSX.Element {
  return (
    <main>
      <h1>agentplex</h1>
      <p>Protocol version {PROTOCOL_VERSION}</p>
    </main>
  );
}
