import { type JSX } from 'react';

import type { TokenStore } from './auth/token.js';
import { AppShell } from './shell/app-shell.js';
import type { HubStore } from './store/hub-store.js';
import { MantineProvider } from './ui/components.js';
import { cssVariablesResolver, theme } from './ui/theme.js';

export interface AppProps {
  /**
   * The one hub store for the whole page. Built by `main.tsx` and handed in
   * rather than built here, so a test can mount the page on a store whose
   * platform seams it filled -- and so there is exactly one place that builds
   * one. Every route reads it through props; a second store anywhere would be
   * a second socket, and a second socket dials with whatever credential it
   * was given, which is how a session screen once presented a token nobody
   * had written.
   */
  readonly hub: HubStore;
  /** Where the credential lives: written by Settings, read by the store's ticket exchange. */
  readonly tokens: TokenStore;
}

/**
 * The root: provider chrome only. The frame itself -- the top bar, the sidebar
 * and the content region every screen mounts into -- is `shell/app-shell.tsx`,
 * so this file changes when the provider stack changes and for no other
 * reason.
 */
export function App({ hub, tokens }: AppProps): JSX.Element {
  return (
    <MantineProvider
      theme={theme}
      cssVariablesResolver={cssVariablesResolver}
      defaultColorScheme="dark"
    >
      <AppShell hub={hub} tokens={tokens} />
    </MantineProvider>
  );
}
