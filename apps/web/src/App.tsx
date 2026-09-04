import { PROTOCOL_VERSION } from '@agentplex/protocol';
import { type JSX } from 'react';

import { SettingsRoute } from './settings/settings-route.js';
import { MantineProvider, Stack, Text, Title } from './ui/components.js';
import { cssVariablesResolver, theme } from './ui/theme.js';

/**
 * The root: provider chrome only. Everything a feature ticket adds mounts
 * inside AppShell, so this file changes when the provider stack changes and
 * for no other reason.
 */
export function App(): JSX.Element {
  return (
    <MantineProvider
      theme={theme}
      cssVariablesResolver={cssVariablesResolver}
      defaultColorScheme="dark"
    >
      <AppShell />
    </MantineProvider>
  );
}

/**
 * Where the application lives. The stacked tickets — session list, terminal
 * pane, layout tree, settings — replace the placeholder below with their
 * routes and panes; the provider stack above stays out of their way.
 *
 * It imports the protocol package so the one workspace dependency the
 * boundaries allow is real from the first commit.
 */
function AppShell(): JSX.Element {
  return (
    <Stack component="main" p="md" gap="md">
      <Title order={1}>agentplex</Title>
      <Text c="dimmed">Protocol version {PROTOCOL_VERSION}</Text>
      <SettingsRoute />
    </Stack>
  );
}
