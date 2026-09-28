import { describe, expect, it } from 'vitest';
import { displayableApprovalText, isDisplayableLabel } from './displayable-text.js';

/**
 * The alphabet both functions read, spelled out as code points so this file
 * says what it covers without an invisible character in it. Hand-written on
 * purpose: the subject is the function, not anything a system produced.
 */
function range(from: number, to: number): number[] {
  return Array.from({ length: to - from + 1 }, (_, offset) => from + offset);
}

const CONTROLS = [...range(0x00, 0x08), ...range(0x0b, 0x1f), ...range(0x7f, 0x9f)];
const BIDI = [0x061c, 0x200e, 0x200f, ...range(0x202a, 0x202e), ...range(0x2066, 0x2069)];

function hex(point: number): string {
  return `U+${point.toString(16).padStart(4, '0')}`;
}

describe('isDisplayableLabel', () => {
  it('refuses every character the approval text removes, because both read one alphabet', () => {
    for (const point of [...CONTROLS, ...BIDI]) {
      const text = `macOS${String.fromCodePoint(point)}26`;
      expect(displayableApprovalText(text), hex(point)).toBe('macOS26');
      expect(isDisplayableLabel(text), hex(point)).toBe(false);
    }
  });

  it('refuses the tab and newline that prose keeps, because a label is one line', () => {
    expect(displayableApprovalText('a\tb\nc')).toBe('a\tb\nc');
    expect(isDisplayableLabel('macOS\t26')).toBe(false);
    expect(isDisplayableLabel('macOS\n26')).toBe(false);
  });

  it('accepts a label with none of them, whatever script it is in', () => {
    for (const text of ['macOS 26.6.2', 'Debian GNU/Linux 12 (bookworm)', 'Fedora Linux 41', '']) {
      expect(isDisplayableLabel(text), JSON.stringify(text)).toBe(true);
    }
    expect(isDisplayableLabel('עברית 1')).toBe(true);
  });
});
