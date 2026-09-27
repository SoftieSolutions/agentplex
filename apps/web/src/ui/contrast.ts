/**
 * WCAG 2 relative luminance and contrast ratio, for the tests that hold the
 * palette to a readable floor.
 *
 * Nothing rendered imports this. A contrast rule is a property of two named
 * hues, so it is checked once against tokens.ts when the suite runs rather
 * than computed in a component on every paint; a pair that fails is a token
 * to change, not a colour to adjust at runtime.
 */

const SIX_DIGIT_HEX = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i;

/** One sRGB channel byte, linearised as the WCAG definition does. */
function linear(byte: string): number {
  const c = Number.parseInt(byte, 16) / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

/**
 * The relative luminance of a `#rrggbb` colour, 0 for black to 1 for white.
 *
 * Only the six-digit form: tokens.ts stores every hue that way, and a
 * shorthand or an alpha form read by the same slicing would come out as a
 * different colour without saying so.
 */
export function relativeLuminance(hex: string): number {
  const match = SIX_DIGIT_HEX.exec(hex);
  if (match === null) throw new Error(`${hex} is not a six-digit hex colour`);
  const [, r = '', g = '', b = ''] = match;
  return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
}

/** The WCAG contrast ratio between two colours, 1 to 21, in either order. */
export function contrastRatio(a: string, b: string): number {
  const one = relativeLuminance(a);
  const two = relativeLuminance(b);
  return (Math.max(one, two) + 0.05) / (Math.min(one, two) + 0.05);
}
