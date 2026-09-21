'use strict';

/**
 * Draws the app icon and writes resources/icon.ico.
 *
 * Generated rather than checked in as a binary blob so the shape, colours
 * and sizes stay readable and editable. Run with: node tools/make-icon.js
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const SIZES = [256, 128, 64, 48, 32, 16];
const OUT = path.join(__dirname, '..', 'resources', 'icon.ico');

/* ---------- tiny drawing helpers ---------- */

/** Signed distance to a rounded rectangle, used for smooth edges. */
function roundedRectDistance(x, y, cx, cy, halfW, halfH, radius) {
  const dx = Math.abs(x - cx) - (halfW - radius);
  const dy = Math.abs(y - cy) - (halfH - radius);
  const outside = Math.hypot(Math.max(dx, 0), Math.max(dy, 0));
  return outside + Math.min(Math.max(dx, dy), 0) - radius;
}

function mix(a, b, amount) {
  return [
    Math.round(a[0] + (b[0] - a[0]) * amount),
    Math.round(a[1] + (b[1] - a[1]) * amount),
    Math.round(a[2] + (b[2] - a[2]) * amount),
  ];
}

/** Antialiasing: turn a distance in pixels into a 0..1 coverage value. */
function coverage(distance, softness) {
  return Math.max(0, Math.min(1, 0.5 - distance / softness));
}

function drawIcon(size) {
  const pixels = Buffer.alloc(size * size * 4);
  const s = size / 256; // everything below is authored at 256px
  const soft = Math.max(1, 1.6 * s);

  const purpleTop = [163, 106, 255];
  const purpleBottom = [110, 40, 232];
  const bubble = [255, 255, 255];
  const glyph = [26, 18, 48];

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const px = x + 0.5;
      const py = y + 0.5;

      // Background: rounded square with a vertical gradient.
      const bg = coverage(roundedRectDistance(px, py, size / 2, size / 2,
        size / 2, size / 2, 58 * s), soft);
      if (bg <= 0) {
        continue;
      }
      let colour = mix(purpleTop, purpleBottom, py / size);
      let alpha = bg;

      // Speech bubble: a rounded rect with a tail cut from a rotated square.
      const body = roundedRectDistance(px, py, 128 * s, 116 * s, 76 * s, 60 * s, 22 * s);
      const tailX = px - 104 * s;
      const tailY = py - 176 * s;
      const tail = Math.abs(tailX) + Math.abs(tailY) - 26 * s;
      const bubbleCoverage = Math.max(coverage(body, soft), coverage(tail, soft));
      if (bubbleCoverage > 0) {
        colour = mix(colour, bubble, bubbleCoverage);
      }

      // A D-pad cross inside the bubble: chat, pressing buttons. Deliberately
      // not two vertical bars, which would read as another service's mark.
      const vertical = roundedRectDistance(px, py, 128 * s, 116 * s, 13 * s, 38 * s, 6 * s);
      const horizontal = roundedRectDistance(px, py, 128 * s, 116 * s, 38 * s, 13 * s, 6 * s);
      const crossCoverage = Math.max(coverage(vertical, soft), coverage(horizontal, soft))
        * bubbleCoverage;
      if (crossCoverage > 0) colour = mix(colour, glyph, crossCoverage);

      const at = (y * size + x) * 4;
      pixels[at] = colour[0];
      pixels[at + 1] = colour[1];
      pixels[at + 2] = colour[2];
      pixels[at + 3] = Math.round(alpha * 255);
    }
  }
  return pixels;
}

/* ---------- PNG ---------- */

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const typed = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(zlib.crc32(typed));
  return Buffer.concat([length, typed, crc]);
}

function toPng(pixels, size) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8;   // bit depth
  header[9] = 6;   // colour type: RGBA
  header[10] = 0;  // deflate
  header[11] = 0;  // adaptive filtering
  header[12] = 0;  // no interlace

  // Each scanline is prefixed with its filter byte (0 = none).
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y += 1) {
    raw[y * (size * 4 + 1)] = 0;
    pixels.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* ---------- ICO ---------- */

function toIco(images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // 1 = icon
  header.writeUInt16LE(images.length, 4);

  const directory = Buffer.alloc(16 * images.length);
  let offset = header.length + directory.length;

  images.forEach((image, index) => {
    const at = index * 16;
    // 0 means 256 in the ICO directory.
    directory[at] = image.size >= 256 ? 0 : image.size;
    directory[at + 1] = image.size >= 256 ? 0 : image.size;
    directory[at + 2] = 0; // palette size
    directory[at + 3] = 0; // reserved
    directory.writeUInt16LE(1, at + 4);  // colour planes
    directory.writeUInt16LE(32, at + 6); // bits per pixel
    directory.writeUInt32LE(image.png.length, at + 8);
    directory.writeUInt32LE(offset, at + 12);
    offset += image.png.length;
  });

  return Buffer.concat([header, directory, ...images.map((i) => i.png)]);
}

const images = SIZES.map((size) => ({ size, png: toPng(drawIcon(size), size) }));
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, toIco(images));

// A standalone PNG is handy for README and release pages.
fs.writeFileSync(path.join(path.dirname(OUT), 'icon.png'), images[0].png);

console.log(`Wrote ${OUT} (${SIZES.join(', ')}px, ${fs.statSync(OUT).size} bytes)`);
