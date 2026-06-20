import { describe, it, expect } from 'vitest';
import { addPngTextChunk, readPngTextChunks, stripPngTextChunks, crc32, blobToBytes } from './pngMetadata';

// A minimal byte sequence the chunk-walker accepts: the 8-byte PNG
// signature followed by a zero-length IEND chunk. addPngTextChunk /
// readPngTextChunks only walk chunks to locate IEND — they don't need a
// real IHDR/IDAT — so this is enough to exercise them.
function makeMinimalPng(): Blob {
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  const iend = [
    0x00, 0x00, 0x00, 0x00,         // length 0
    0x49, 0x45, 0x4e, 0x44,         // "IEND"
    0xae, 0x42, 0x60, 0x82,         // CRC of IEND (standard)
  ];
  return new Blob([new Uint8Array([...sig, ...iend])], { type: 'image/png' });
}

const bytesOf = blobToBytes;

describe('pngMetadata', () => {
  it('round-trips a text chunk (add then read)', async () => {
    const png = makeMinimalPng();
    const payload = JSON.stringify({ url: 'https://rollout-viz.com/?file=x', rollout: 42, step: 1 });
    const withMeta = await addPngTextChunk(png, 'rollout-viz', payload);
    const chunks = await readPngTextChunks(withMeta);
    expect(chunks['rollout-viz']).toBe(payload);
  });

  it('preserves a UTF-8 payload', async () => {
    const png = makeMinimalPng();
    const payload = 'experiment "réward hacking" — étape 1';
    const withMeta = await addPngTextChunk(png, 'note', payload);
    expect((await readPngTextChunks(withMeta))['note']).toBe(payload);
  });

  it('supports multiple text chunks', async () => {
    let png = makeMinimalPng();
    png = await addPngTextChunk(png, 'a', 'first');
    png = await addPngTextChunk(png, 'b', 'second');
    const chunks = await readPngTextChunks(png);
    expect(chunks).toEqual({ a: 'first', b: 'second' });
  });

  it('strips only selected text metadata chunks', async () => {
    let png = makeMinimalPng();
    png = await addPngTextChunk(png, 'rollout-viz', 'hidden source path');
    png = await addPngTextChunk(png, 'note', 'keep me');

    const stripped = await stripPngTextChunks(png, ['rollout-viz']);

    expect(await readPngTextChunks(stripped)).toEqual({ note: 'keep me' });
  });

  it('strips all text metadata chunks when no keyword list is supplied', async () => {
    let png = makeMinimalPng();
    png = await addPngTextChunk(png, 'rollout-viz', 'hidden source path');
    png = await addPngTextChunk(png, 'note', 'drop me too');

    const stripped = await stripPngTextChunks(png);

    expect(await readPngTextChunks(stripped)).toEqual({});
  });

  it('inserts the new chunk before IEND, keeping IEND last', async () => {
    const withMeta = await addPngTextChunk(makeMinimalPng(), 'k', 'v');
    const bytes = await bytesOf(withMeta);
    // Last 12 bytes must still be the IEND chunk.
    const tail = bytes.subarray(bytes.length - 12);
    expect(String.fromCharCode(tail[4], tail[5], tail[6], tail[7])).toBe('IEND');
  });

  it('writes a valid CRC-32 for the inserted chunk', async () => {
    const withMeta = await addPngTextChunk(makeMinimalPng(), 'rollout-viz', 'check');
    const bytes = await bytesOf(withMeta);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    // Walk to the tEXt chunk.
    let offset = 8;
    let found = false;
    while (offset + 8 <= bytes.length) {
      const len = view.getUint32(offset, false);
      const type = String.fromCharCode(
        bytes[offset + 4], bytes[offset + 5], bytes[offset + 6], bytes[offset + 7],
      );
      if (type === 'tEXt') {
        const typeAndData = bytes.subarray(offset + 4, offset + 8 + len);
        const storedCrc = view.getUint32(offset + 8 + len, false);
        expect(crc32(typeAndData)).toBe(storedCrc);
        found = true;
        break;
      }
      if (type === 'IEND') break;
      offset += 12 + len;
    }
    expect(found).toBe(true);
  });

  it('returns a non-PNG blob unchanged and reads {} from it', async () => {
    const notPng = new Blob([new Uint8Array([1, 2, 3, 4])], { type: 'image/png' });
    const out = await addPngTextChunk(notPng, 'k', 'v');
    expect(await bytesOf(out)).toEqual(new Uint8Array([1, 2, 3, 4]));
    expect(await readPngTextChunks(notPng)).toEqual({});
  });
});
