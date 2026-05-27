// PNG tEXt-chunk metadata — embed / extract hidden text in a PNG.
//
// Used by Presentation Mode to stamp a deep link to the source rollout into
// exported images. PNG layout: an 8-byte signature, then a sequence of
// chunks `[length:4 BE][type:4 ASCII][data:length][crc:4]` where the CRC
// covers `type + data`; the stream ends with a zero-length `IEND` chunk.
// A `tEXt` chunk's data is `keyword\0text`. We splice ours in immediately
// before `IEND`.
//
// The PNG spec types `tEXt` as Latin-1; we write UTF-8 bytes, which every
// common reader (exiftool, ImageMagick, …) round-trips fine for the
// ASCII-ish JSON we store. Keywords stay ASCII.

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

// CRC-32 (PNG variant: poly 0xEDB88320, pre/post-inverted) with a
// lazily-built 256-entry lookup table. Exported for tests.
let crcTable: Uint32Array | null = null;
function getCrcTable(): Uint32Array {
  if (crcTable) return crcTable;
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    t[n] = c >>> 0;
  }
  crcTable = t;
  return t;
}

export function crc32(bytes: Uint8Array): number {
  const t = getCrcTable();
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    c = t[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function isPng(bytes: Uint8Array): boolean {
  if (bytes.length < 8) return false;
  for (let i = 0; i < 8; i++) if (bytes[i] !== PNG_SIGNATURE[i]) return false;
  return true;
}

// Blob -> bytes. Real browsers have Blob.arrayBuffer(); jsdom (test env)
// does not, so fall back to FileReader there.
export async function blobToBytes(blob: Blob): Promise<Uint8Array> {
  if (typeof blob.arrayBuffer === 'function') {
    return new Uint8Array(await blob.arrayBuffer());
  }
  return new Promise<Uint8Array>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(new Uint8Array(reader.result as ArrayBuffer));
    reader.onerror = () => reject(reader.error);
    reader.readAsArrayBuffer(blob);
  });
}

/**
 * Return a new PNG Blob with a `tEXt` chunk (`keyword\0text`) inserted
 * before `IEND`. If `png` is not a valid PNG, it's returned unchanged.
 */
export async function addPngTextChunk(
  png: Blob,
  keyword: string,
  text: string,
): Promise<Blob> {
  const bytes = await blobToBytes(png);
  if (!isPng(bytes)) return png;

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  // Walk chunks from offset 8 to find where IEND begins.
  let offset = 8;
  let iendStart = -1;
  while (offset + 8 <= bytes.length) {
    const len = view.getUint32(offset, false);
    const type = String.fromCharCode(
      bytes[offset + 4], bytes[offset + 5], bytes[offset + 6], bytes[offset + 7],
    );
    if (type === 'IEND') { iendStart = offset; break; }
    offset += 12 + len; // 4 length + 4 type + len data + 4 crc
  }
  if (iendStart === -1) return png; // malformed — leave untouched

  // tEXt data = keyword bytes + NUL + text bytes.
  const enc = new TextEncoder();
  const keywordBytes = enc.encode(keyword);
  const textBytes = enc.encode(text);
  const data = new Uint8Array(keywordBytes.length + 1 + textBytes.length);
  data.set(keywordBytes, 0);
  data[keywordBytes.length] = 0;
  data.set(textBytes, keywordBytes.length + 1);

  const typeBytes = enc.encode('tEXt');
  const crcInput = new Uint8Array(4 + data.length);
  crcInput.set(typeBytes, 0);
  crcInput.set(data, 4);
  const crc = crc32(crcInput);

  // Assemble the chunk: [length][type][data][crc].
  const chunk = new Uint8Array(12 + data.length);
  const chunkView = new DataView(chunk.buffer);
  chunkView.setUint32(0, data.length, false);
  chunk.set(typeBytes, 4);
  chunk.set(data, 8);
  chunkView.setUint32(8 + data.length, crc, false);

  // Splice the new chunk in just before IEND.
  const out = new Uint8Array(bytes.length + chunk.length);
  out.set(bytes.subarray(0, iendStart), 0);
  out.set(chunk, iendStart);
  out.set(bytes.subarray(iendStart), iendStart + chunk.length);

  return new Blob([out], { type: 'image/png' });
}

/**
 * Read all `tEXt` chunks from a PNG into a `{ keyword: text }` map.
 * Returns `{}` for a non-PNG or a PNG with no text chunks.
 */
export async function readPngTextChunks(png: Blob): Promise<Record<string, string>> {
  const bytes = await blobToBytes(png);
  const result: Record<string, string> = {};
  if (!isPng(bytes)) return result;

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const dec = new TextDecoder();
  let offset = 8;
  while (offset + 8 <= bytes.length) {
    const len = view.getUint32(offset, false);
    const type = String.fromCharCode(
      bytes[offset + 4], bytes[offset + 5], bytes[offset + 6], bytes[offset + 7],
    );
    if (type === 'IEND') break;
    if (type === 'tEXt') {
      const data = bytes.subarray(offset + 8, offset + 8 + len);
      const nul = data.indexOf(0);
      if (nul !== -1) {
        result[dec.decode(data.subarray(0, nul))] = dec.decode(data.subarray(nul + 1));
      }
    }
    offset += 12 + len;
  }
  return result;
}
