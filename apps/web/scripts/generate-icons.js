/**
 * Generates the PWA icon PNGs into public/icons/. Run with
 * `pnpm --filter @agentplex/web icons`; the outputs are committed, so the
 * build does not depend on this script and CI never draws pixels.
 *
 * Written against nothing but node's own zlib so that icons do not cost the
 * app an image-processing dependency. The colors come from the tokens module
 * (node 24 strips the types on import): no color literal lives here.
 *
 * The mark is a two-by-two grid of panes with one pane in the accent hue —
 * many sessions, one in focus — drawn in pixels because a PNG this simple
 * needs no rasterizer.
 */

import { deflateSync, crc32 } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { hues } from '../src/ui/tokens.ts';

const outDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'icons');

/** @param {string} hex six-digit lowercase hex, the only format tokens.ts emits */
function rgb(hex) {
  return [
    Number.parseInt(hex.slice(1, 3), 16),
    Number.parseInt(hex.slice(3, 5), 16),
    Number.parseInt(hex.slice(5, 7), 16),
  ];
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body) >>> 0);
  return Buffer.concat([length, body, crc]);
}

/** @param {number} size @param {(x: number, y: number) => [number, number, number]} pixel */
function encodePng(size, pixel) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type: truecolor
  const raw = Buffer.alloc(size * (1 + size * 3));
  for (let y = 0; y < size; y += 1) {
    const row = y * (1 + size * 3);
    raw[row] = 0; // filter: none
    for (let x = 0; x < size; x += 1) {
      const [r, g, b] = pixel(x, y);
      const at = row + 1 + x * 3;
      raw[at] = r;
      raw[at + 1] = g;
      raw[at + 2] = b;
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const background = rgb(hues.midnight);
const pane = rgb(hues.fog);
const focused = rgb(hues.signal);

/**
 * @param {number} size
 * @param {number} scale fraction of the canvas the mark occupies; maskable
 *   icons shrink it to sit inside the platform's safe zone
 */
function drawIcon(size, scale) {
  const art = size * scale;
  const paneSide = art * 0.44;
  const gap = art * 0.12;
  const origin = (size - art) / 2;
  const starts = [origin, origin + paneSide + gap];
  return encodePng(size, (x, y) => {
    for (const [column, sx] of starts.entries()) {
      for (const [row, sy] of starts.entries()) {
        if (x >= sx && x < sx + paneSide && y >= sy && y < sy + paneSide) {
          return column === 1 && row === 1 ? focused : pane;
        }
      }
    }
    return background;
  });
}

mkdirSync(outDir, { recursive: true });
const outputs = [
  ['icon-192.png', drawIcon(192, 0.72)],
  ['icon-512.png', drawIcon(512, 0.72)],
  ['icon-maskable-512.png', drawIcon(512, 0.5)],
  ['apple-touch-icon.png', drawIcon(180, 0.6)],
];
for (const [name, png] of outputs) {
  writeFileSync(join(outDir, name), png);
  console.log(`wrote ${join(outDir, name)} (${png.length} bytes)`);
}
