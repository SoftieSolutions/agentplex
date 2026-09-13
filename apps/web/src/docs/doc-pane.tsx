import { useState, useSyncExternalStore, type JSX } from 'react';
import type { NodeId } from '@agentplex/protocol';

import type { HubStore } from '../store/hub-store.js';
import { browserTimers } from '../store/timers.js';
import { useHubLayout } from '../store/use-hub-store.js';
import { createShortcutRegistry, type ShortcutRegistry } from '../terminal/shortcuts.js';
import { Box, Button, Group, Stack, Text, useComputedColorScheme } from '../ui/components.js';
import { colorForRole, colorForTone, type Scheme } from '../ui/tokens.js';
import { createDocEditorStore, type DocEditorStore } from './doc-editor-store.js';
import { documentName } from './doc-rows.js';
import { editorWords, isDirty } from './editor-model.js';
import { MarkdownView } from './markdown-view.js';

/**
 * A document open in a pane: a header, a monospace textarea, and a preview.
 *
 * The editor itself is a plain textarea and no third-party editor, which is a
 * decision rather than a placeholder. What this pane is for is the markdown
 * somebody writes at an agent, the browser already knows how to edit text, and
 * a code editor would bring a mode system, a theme and a bundle to a box that
 * needs none of them.
 *
 * ## Where the text lives
 *
 * Not here. `doc-editor-store.ts` holds it, for the lifetime of the pane and
 * across every reconnection underneath it; this component subscribes and
 * renders. The two pieces of React state are what the *view* is doing --
 * whether the preview is showing, and the pane's own shortcut registry -- and
 * neither survives a remount because neither should.
 *
 * ## The save chord
 *
 * Cmd/Ctrl+Shift+S, through the same registry the panes use, because that is
 * the chord space this app has: `shortcuts.ts` reserves plain Ctrl-letter for
 * the terminal and plain Cmd-letter for the browser, and a pane that took plain
 * Cmd+S would be the one exception to a rule the other panes keep. The button
 * beside the chord does the same thing for anyone who would rather click, and
 * an idle save goes out on its own a moment after typing stops.
 */

const MONO = { fontFamily: 'var(--mantine-font-family-monospace)' } as const;

export interface DocPaneProps {
  readonly nodeId: NodeId;
  /** The page's one hub store, handed down by the pane that mounts this. */
  readonly store: HubStore;
  /** The clock, injected so a test can render a fixed age. */
  readonly now?: () => number;
}

export function DocPane({ nodeId, store: hub, now = Date.now }: DocPaneProps): JSX.Element {
  const scheme: Scheme = useComputedColorScheme('dark');
  // Pane-lifetime collaborators, not render data: one editor store and one
  // registry per mounted pane. The layout keys the pane on the node, so
  // another document gets fresh ones.
  const [editor] = useState<DocEditorStore>(() =>
    createDocEditorStore({ hub, nodeId, timers: browserTimers }),
  );
  const [registry] = useState<ShortcutRegistry>(() => {
    const bindings = createShortcutRegistry();
    bindings.register({
      key: 's',
      description: 'save the document',
      run: () => editor.save(),
    });
    return bindings;
  });
  const state = useSyncExternalStore(editor.subscribe, editor.getSnapshot);
  const layout = useHubLayout(hub);
  const [preview, setPreview] = useState(false);

  const name = documentName(layout, nodeId) ?? nodeId;
  const dirty = isDirty(state);
  const words = editorWords(state, now());
  const border = `1px solid ${colorForRole('border', scheme)}`;

  return (
    <Stack
      gap={0}
      style={{ height: '100%' }}
      // Capture phase on the pane's root, the way the session pane decides its
      // chords: the layout's own handler sits further out and has already had
      // its say.
      onKeyDownCapture={(event) => registry.handleKeyDown(event)}
    >
      <Group gap={10} px={18} py={10} style={{ borderBottom: border }} wrap="nowrap">
        <Text fw={700} fz={15} style={{ whiteSpace: 'nowrap' }}>
          {name}
        </Text>
        <Group gap={5} wrap="nowrap" style={{ flex: 1, minWidth: 0 }}>
          <Box
            w={6}
            h={6}
            style={{
              borderRadius: '50%',
              background: colorForTone(dirty ? 'needs-you' : 'idle', scheme),
            }}
          />
          <Text fz={10} fw={500} style={{ ...MONO, color: colorForRole('textMuted', scheme) }}>
            {words}
          </Text>
        </Group>
        <Button size="xs" variant="default" onClick={() => setPreview(!preview)}>
          {preview ? 'Edit' : 'Preview'}
        </Button>
        <Button size="xs" onClick={() => editor.save()} disabled={!dirty}>
          Save
        </Button>
      </Group>

      {preview ? (
        <Box p={18} style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>
          <MarkdownView text={state.text} scheme={scheme} />
        </Box>
      ) : (
        <textarea
          value={state.text}
          onChange={(event) => editor.setText(event.currentTarget.value)}
          // Read-only until the machine has answered: an empty box somebody
          // could type into is an invitation to write over a document this
          // client has never seen.
          readOnly={!state.loaded}
          spellCheck={false}
          aria-label={`the document ${name}`}
          placeholder={state.loaded ? '' : 'nothing to edit until the machine answers'}
          style={{
            flex: 1,
            minHeight: 0,
            resize: 'none',
            border: 'none',
            outline: 'none',
            padding: 18,
            ...MONO,
            fontSize: 13,
            lineHeight: 1.55,
            background: colorForRole('background', scheme),
            color: colorForRole(state.loaded ? 'text' : 'textFaint', scheme),
          }}
        />
      )}

      {state.refusal === null ? null : (
        <Text
          fz={11}
          px={18}
          py={6}
          style={{ borderTop: border, color: colorForTone('blocked', scheme) }}
        >
          {state.refusal}
        </Text>
      )}
    </Stack>
  );
}
