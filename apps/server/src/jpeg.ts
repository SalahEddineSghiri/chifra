import { readFile } from "node:fs/promises";

const SOF_MARKERS = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);
const MAX_IMAGE_PIXELS = 40_000_000;
const MAX_IMAGE_SIDE = 20_000;

export type JpegDimensions = { width: number; height: number };

export function parseJpegDimensions(data: Buffer): JpegDimensions | null {
  if (data.length < 4 || data[0] !== 0xff || data[1] !== 0xd8) return null;
  let offset = 2;
  while (offset + 3 < data.length) {
    if (data[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    while (data[offset] === 0xff) offset += 1;
    const marker = data[offset];
    offset += 1;
    if (marker === undefined || marker === 0xd9 || marker === 0xda) break;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 1 >= data.length) return null;
    const length = data.readUInt16BE(offset);
    if (length < 2 || offset + length > data.length) return null;
    if (SOF_MARKERS.has(marker)) {
      if (length < 7) return null;
      const height = data.readUInt16BE(offset + 3);
      const width = data.readUInt16BE(offset + 5);
      if (width < 1 || height < 1 || width > MAX_IMAGE_SIDE || height > MAX_IMAGE_SIDE
        || width * height > MAX_IMAGE_PIXELS) return null;
      return { width, height };
    }
    offset += length;
  }
  return null;
}

export async function readJpegDimensions(path: string): Promise<JpegDimensions | null> {
  return parseJpegDimensions(await readFile(path));
}
