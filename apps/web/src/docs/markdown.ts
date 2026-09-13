/**
 * Markdown, as far as a preview needs it: text in, a small block model out.
 *
 * ## Why this is not a markdown-to-HTML converter
 *
 * The obvious shape -- build an HTML string and hand it to
 * `dangerouslySetInnerHTML` -- puts the safety of every document somebody
 * opens on this file getting escaping right, forever, for input that arrives
 * from another machine's disk. This produces a value instead: blocks and
 * spans, rendered as React elements by `markdown-view.tsx`, so every character
 * this parser did not recognise reaches the screen as a text node. `<script>`
 * in a document is five characters and an angle bracket, not a decision this
 * module has to get right, and no string of HTML is ever built to get wrong.
 *
 * The cost is a small syntax, stated rather than implied: headings, block
 * quotes, fenced and inline code, bullet and numbered lists, thematic breaks,
 * bold and italic. Anything else is its own literal text -- a table renders as
 * the pipes somebody typed, and so does a raw HTML tag.
 *
 * Links are deliberately absent, and that is the one omission worth arguing.
 * A link is a URL a reader clicks, `javascript:` is a URL, and a cheap
 * converter that renders link syntax is exactly the converter that gets that
 * wrong. So `[text](url)` renders as the characters it is, which shows the
 * reader both halves and clicks nowhere.
 */

/** A run of characters inside a block, and what it is. */
export type Inline =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'code'; readonly text: string }
  | { readonly kind: 'strong'; readonly text: string }
  | { readonly kind: 'em'; readonly text: string };

export type Block =
  | { readonly kind: 'heading'; readonly level: number; readonly spans: readonly Inline[] }
  | { readonly kind: 'paragraph'; readonly spans: readonly Inline[] }
  | { readonly kind: 'quote'; readonly spans: readonly Inline[] }
  | {
      readonly kind: 'list';
      readonly ordered: boolean;
      readonly items: readonly (readonly Inline[])[];
    }
  /** A fenced block, verbatim: nothing inside one is read as markup. */
  | { readonly kind: 'code'; readonly text: string }
  | { readonly kind: 'rule' };

/** Deeper than markdown goes; a seventh hash is text. */
const MAX_HEADING = 6;

const FENCE = '```';
const BULLET = /^\s{0,3}[-*+]\s+(.*)$/;
const NUMBERED = /^\s{0,3}\d{1,9}[.)]\s+(.*)$/;
const HEADING = /^(#{1,6})\s+(.*)$/;
const QUOTE = /^\s{0,3}>\s?(.*)$/;
const RULE = /^\s{0,3}(?:-{3,}|\*{3,}|_{3,})\s*$/;

/** A `marker … marker` run at the head of `rest`, or `null`. */
function delimited(rest: string, marker: string): { inner: string; length: number } | null {
  if (!rest.startsWith(marker)) return null;
  const close = rest.indexOf(marker, marker.length);
  if (close === -1) return null;
  const inner = rest.slice(marker.length, close);
  // An empty run is the literal markers: `**` is two asterisks somebody typed.
  if (inner.length === 0) return null;
  return { inner, length: close + marker.length };
}

/**
 * One line of text as spans. Total by construction: an unmatched marker is
 * kept as the character it is, so every input has a reading.
 */
export function parseInline(line: string): readonly Inline[] {
  const spans: Inline[] = [];
  let plain = '';
  const flush = (): void => {
    if (plain.length > 0) spans.push({ kind: 'text', text: plain });
    plain = '';
  };

  let index = 0;
  while (index < line.length) {
    const rest = line.slice(index);
    // Code first, and the order is the rule: a backtick run is verbatim, so
    // asterisks inside one are asterisks.
    const code = delimited(rest, '`');
    if (code !== null) {
      flush();
      spans.push({ kind: 'code', text: code.inner });
      index += code.length;
      continue;
    }
    const strong = delimited(rest, '**');
    if (strong !== null) {
      flush();
      spans.push({ kind: 'strong', text: strong.inner });
      index += strong.length;
      continue;
    }
    const em = delimited(rest, '*') ?? delimited(rest, '_');
    if (em !== null) {
      flush();
      spans.push({ kind: 'em', text: em.inner });
      index += em.length;
      continue;
    }
    plain += rest[0] ?? '';
    index += 1;
  }
  flush();
  return spans;
}

/**
 * The document as blocks.
 *
 * Line-oriented and single-pass. Everything it does not recognise falls
 * through to a paragraph, which is the direction that does not over-claim: a
 * preview of a document this parser half-understood still shows every word in
 * it.
 */
export function parseMarkdown(text: string): readonly Block[] {
  const lines = text.split('\n');
  const blocks: Block[] = [];
  let paragraph: string[] = [];
  let quote: string[] = [];
  let list: { ordered: boolean; items: string[] } | null = null;

  function closeParagraph(): void {
    if (paragraph.length === 0) return;
    blocks.push({ kind: 'paragraph', spans: parseInline(paragraph.join(' ')) });
    paragraph = [];
  }
  function closeQuote(): void {
    if (quote.length === 0) return;
    blocks.push({ kind: 'quote', spans: parseInline(quote.join(' ')) });
    quote = [];
  }
  function closeList(): void {
    if (list === null) return;
    blocks.push({
      kind: 'list',
      ordered: list.ordered,
      items: list.items.map((item) => parseInline(item)),
    });
    list = null;
  }
  function closeAll(): void {
    closeParagraph();
    closeQuote();
    closeList();
  }

  let index = 0;
  while (index < lines.length) {
    const line = lines[index] ?? '';
    index += 1;

    if (line.trimStart().startsWith(FENCE)) {
      closeAll();
      const body: string[] = [];
      while (index < lines.length && !(lines[index] ?? '').trimStart().startsWith(FENCE)) {
        body.push(lines[index] ?? '');
        index += 1;
      }
      // An unclosed fence ends at the end of the document rather than eating
      // the rest of it silently: the text is shown either way.
      index += 1;
      blocks.push({ kind: 'code', text: body.join('\n') });
      continue;
    }

    if (line.trim() === '') {
      closeAll();
      continue;
    }

    const rule = RULE.exec(line);
    if (rule !== null) {
      closeAll();
      blocks.push({ kind: 'rule' });
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading !== null) {
      closeAll();
      const hashes = heading[1] ?? '';
      blocks.push({
        kind: 'heading',
        level: Math.min(hashes.length, MAX_HEADING),
        spans: parseInline(heading[2] ?? ''),
      });
      continue;
    }

    const quoted = QUOTE.exec(line);
    if (quoted !== null) {
      closeParagraph();
      closeList();
      quote.push(quoted[1] ?? '');
      continue;
    }

    const bullet = BULLET.exec(line);
    const numbered = bullet === null ? NUMBERED.exec(line) : null;
    if (bullet !== null || numbered !== null) {
      closeParagraph();
      closeQuote();
      const ordered = numbered !== null;
      if (list !== null && list.ordered !== ordered) closeList();
      list ??= { ordered, items: [] };
      list.items.push(bullet?.[1] ?? numbered?.[1] ?? '');
      continue;
    }

    closeQuote();
    closeList();
    paragraph.push(line);
  }

  closeAll();
  return blocks;
}
