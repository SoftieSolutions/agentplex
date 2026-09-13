import { type JSX } from 'react';
import { Box, Stack, Text } from '../ui/components.js';
import { colorForRole, type Scheme } from '../ui/tokens.js';
import { parseMarkdown, type Block, type Inline } from './markdown.js';

/**
 * The preview: the block model rendered as React elements.
 *
 * No HTML string is built anywhere in this file, which is the whole safety
 * argument and the reason `markdown.ts` produces a value rather than markup. A
 * document arrives from another machine's disk, and every character this
 * client did not recognise reaches the screen as a text node -- React escapes
 * it because it is text, not because anybody remembered to.
 */

const MONO = { fontFamily: 'var(--mantine-font-family-monospace)' } as const;

/** Heading sizes, largest first. Plain numbers: type scale, not a hue. */
const HEADING_SIZES = [20, 17, 15, 14, 13, 13] as const;

export interface MarkdownViewProps {
  readonly text: string;
  readonly scheme: Scheme;
}

export function MarkdownView({ text, scheme }: MarkdownViewProps): JSX.Element {
  const blocks = parseMarkdown(text);
  if (blocks.length === 0) {
    return (
      <Text fz={12} style={{ color: colorForRole('textFaint', scheme) }}>
        this document is empty
      </Text>
    );
  }
  return (
    <Stack gap={10}>
      {blocks.map((block, index) => (
        <BlockView key={index} block={block} scheme={scheme} />
      ))}
    </Stack>
  );
}

interface BlockViewProps {
  readonly block: Block;
  readonly scheme: Scheme;
}

function BlockView({ block, scheme }: BlockViewProps): JSX.Element {
  switch (block.kind) {
    case 'heading':
      return (
        <Text fz={HEADING_SIZES[block.level - 1] ?? 13} fw={700}>
          <Spans spans={block.spans} scheme={scheme} />
        </Text>
      );
    case 'paragraph':
      return (
        <Text fz={13}>
          <Spans spans={block.spans} scheme={scheme} />
        </Text>
      );
    case 'quote':
      return (
        <Box
          pl={10}
          style={{
            borderLeft: `2px solid ${colorForRole('border', scheme)}`,
            color: colorForRole('textMuted', scheme),
          }}
        >
          <Text fz={13} style={{ color: colorForRole('textMuted', scheme) }}>
            <Spans spans={block.spans} scheme={scheme} />
          </Text>
        </Box>
      );
    case 'list':
      return (
        <Stack gap={3}>
          {block.items.map((item, index) => (
            <Text key={index} fz={13}>
              <Text component="span" fz={13} style={{ color: colorForRole('textMuted', scheme) }}>
                {block.ordered ? `${String(index + 1)}. ` : '- '}
              </Text>
              <Spans spans={item} scheme={scheme} />
            </Text>
          ))}
        </Stack>
      );
    case 'code':
      return (
        <Box
          p={10}
          style={{
            background: colorForRole('surfaceAlt', scheme),
            border: `1px solid ${colorForRole('border', scheme)}`,
            borderRadius: 5,
            overflowX: 'auto',
          }}
        >
          <Text fz={12} style={{ ...MONO, whiteSpace: 'pre' }}>
            {block.text}
          </Text>
        </Box>
      );
    case 'rule':
      return <Box h={1} style={{ background: colorForRole('border', scheme) }} />;
  }
}

interface SpansProps {
  readonly spans: readonly Inline[];
  readonly scheme: Scheme;
}

function Spans({ spans, scheme }: SpansProps): JSX.Element {
  return (
    <>
      {spans.map((span, index) => (
        <SpanView key={index} span={span} scheme={scheme} />
      ))}
    </>
  );
}

interface SpanViewProps {
  readonly span: Inline;
  readonly scheme: Scheme;
}

function SpanView({ span, scheme }: SpanViewProps): JSX.Element {
  switch (span.kind) {
    case 'text':
      return <>{span.text}</>;
    case 'code':
      return (
        <Text
          component="span"
          fz={12}
          style={{
            ...MONO,
            background: colorForRole('surfaceAlt', scheme),
            borderRadius: 3,
            padding: '1px 4px',
          }}
        >
          {span.text}
        </Text>
      );
    case 'strong':
      return (
        <Text component="span" fw={700} fz="inherit">
          {span.text}
        </Text>
      );
    case 'em':
      return (
        <Text component="span" fz="inherit" style={{ fontStyle: 'italic' }}>
          {span.text}
        </Text>
      );
  }
}
