/**
 * Image sniffing and metadata stripping.
 *
 * Two jobs, both done on raw bytes with no image library — which matters,
 * because decoding an attacker-supplied image is one of the larger remote-code
 * -execution surfaces in any web stack, and none of what is needed here
 * requires decoding a single pixel.
 *
 *  1. SNIFF. Decide what a file actually is from its leading bytes, rather
 *     than believing the Content-Type the client chose.
 *
 *  2. STRIP. Remove EXIF and other metadata. This is not tidiness — phone
 *     photos carry GPS coordinates, and a listing photo published with its
 *     metadata intact discloses the exact location of the property. It would
 *     also make the map architecture pointless: Portage takes deliberate care
 *     to source coordinates from open data because Apple's licence forbids
 *     storing theirs, and leaking a precise one through image metadata undoes
 *     that entirely.
 *
 * Orientation is the one tag worth keeping, and it cannot be kept: rotating
 * the pixels needs a decoder. So `stripMetadata` reports the orientation it
 * removed, and the caller records it — the browser can then apply the rotation
 * with a CSS transform, which is what the upload path does before compressing
 * anyway.
 *
 * What is NOT here, and why:
 *
 *   - Resizing. Needs a decoder. Cloudflare Image Resizing does it at the
 *     edge; see docs/image-storage-strategy.md.
 *   - BlurHash and perceptual hash. Both need pixel data. BlurHash can come
 *     from the browser (it is a cosmetic placeholder, so a dishonest one only
 *     spoils the uploader's own card). A perceptual hash CANNOT — it is an
 *     anti-fraud signal for detecting stolen photos, and a client-supplied
 *     one is worth nothing. It stays unimplemented rather than fake.
 */

export type ImageKind = 'jpeg' | 'png' | 'webp' | 'gif' | 'avif' | 'heic' | 'unknown';

/** What a browser is willing to render. HEIC is accepted on upload but must be converted. */
export const RENDERABLE: ReadonlySet<ImageKind> = new Set(['jpeg', 'png', 'webp', 'gif', 'avif']);

/**
 * Identifies an image from its leading bytes.
 *
 * The Content-Type header is chosen by the uploader and means nothing. A file
 * claiming `image/jpeg` that begins `<?php` or `<svg onload=…` is the oldest
 * trick there is, and the only defence that works is reading the bytes.
 */
export function sniffImage(bytes: Uint8Array): ImageKind {
  // Each signature is checked against its OWN length requirement rather than
  // one blanket minimum. A JPEG is identifiable from three bytes; refusing to
  // look until twelve have arrived would call a short-but-valid file unknown,
  // and this function's answer decides whether a file is accepted at all.
  if (bytes.length < 3) return 'unknown';

  // JPEG: SOI marker.
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpeg';

  if (bytes.length < 8) return 'unknown';

  // PNG: the 8-byte signature, which deliberately includes bytes that survive
  // neither a text-mode transfer nor a naive CR/LF translation.
  if (
    bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 &&
    bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a
  ) return 'png';

  if (bytes.length < 12) return 'unknown';

  // GIF87a / GIF89a.
  if (ascii(bytes, 0, 6) === 'GIF87a' || ascii(bytes, 0, 6) === 'GIF89a') return 'gif';

  // RIFF container: "RIFF" then 4 size bytes then the form type.
  if (ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 4) === 'WEBP') return 'webp';

  // ISO base media (BMFF): a 4-byte size, "ftyp", then the brand.
  if (ascii(bytes, 4, 4) === 'ftyp') {
    const brand = ascii(bytes, 8, 4);
    if (brand === 'avif' || brand === 'avis') return 'avif';
    if (['heic', 'heix', 'hevc', 'hevx', 'mif1', 'msf1'].includes(brand)) return 'heic';
  }
  return 'unknown';
}

/** The MIME type a sniffed kind should actually be served as. */
export function mimeFor(kind: ImageKind): string | null {
  switch (kind) {
    case 'jpeg': return 'image/jpeg';
    case 'png': return 'image/png';
    case 'webp': return 'image/webp';
    case 'gif': return 'image/gif';
    case 'avif': return 'image/avif';
    case 'heic': return 'image/heic';
    default: return null;
  }
}

function ascii(b: Uint8Array, at: number, len: number): string {
  if (at + len > b.length) return '';
  let s = '';
  for (let i = at; i < at + len; i++) s += String.fromCharCode(b[i]!);
  return s;
}

export interface StripResult {
  bytes: Uint8Array;
  /** True when anything was actually removed. */
  changed: boolean;
  /** Which metadata containers were found, for the audit trail. */
  removed: string[];
  /** EXIF orientation (1–8) if one was present, so the caller can record it. */
  orientation: number | null;
  /** True when EXIF carrying GPS tags was found. Worth logging: it means the
   *  uploader's device recorded where the photo was taken. */
  hadGps: boolean;
}

const unchanged = (bytes: Uint8Array): StripResult =>
  ({ bytes, changed: false, removed: [], orientation: null, hadGps: false });

/** Dispatches on the sniffed kind. An unknown kind is returned untouched. */
export function stripMetadata(bytes: Uint8Array): StripResult {
  switch (sniffImage(bytes)) {
    case 'jpeg': return stripJpeg(bytes);
    case 'png': return stripPng(bytes);
    case 'webp': return stripWebp(bytes);
    default: return unchanged(bytes);
  }
}

// ── JPEG ────────────────────────────────────────────────────────────────────

/**
 * A JPEG is a sequence of segments: 0xFF, a marker byte, then a two-byte
 * big-endian length that INCLUDES those two bytes. Metadata lives in the APPn
 * application segments and in COM comments, and every one of them can be
 * dropped without touching the image data.
 *
 * APP2 is kept when it carries an ICC colour profile — discarding that makes
 * wide-gamut photos render with visibly wrong colour, and it holds nothing
 * about the photographer or the location.
 *
 * Scanning stops at SOS (start of scan), after which the rest of the file is
 * entropy-coded image data with no segment structure to parse.
 */
export function stripJpeg(bytes: Uint8Array): StripResult {
  const out: Array<[number, number]> = [];   // [start, end) ranges to keep
  const removed: string[] = [];
  let orientation: number | null = null;
  let hadGps = false;

  let i = 2;                                  // past SOI
  out.push([0, 2]);

  while (i + 3 < bytes.length) {
    if (bytes[i] !== 0xff) break;             // not a marker: malformed
    const marker = bytes[i + 1]!;

    // Standalone markers carry no length.
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      out.push([i, i + 2]);
      i += 2;
      continue;
    }
    if (marker === 0xda) {                    // SOS: image data to the end
      out.push([i, bytes.length]);
      break;
    }

    const len = (bytes[i + 2]! << 8) | bytes[i + 3]!;
    if (len < 2 || i + 2 + len > bytes.length) break;   // truncated
    const segStart = i;
    const segEnd = i + 2 + len;

    const isApp = marker >= 0xe0 && marker <= 0xef;
    const isComment = marker === 0xfe;

    if (isApp || isComment) {
      const tag = isComment ? 'COM' : `APP${marker - 0xe0}`;
      const payload = bytes.subarray(i + 4, segEnd);

      if (marker === 0xe1 && startsWith(payload, 'Exif\0\0')) {
        const exif = readExif(payload.subarray(6));
        orientation = exif.orientation;
        hadGps = exif.hadGps;
        removed.push('EXIF');
      } else if (marker === 0xe1) {
        removed.push('XMP');
      } else if (marker === 0xed) {
        removed.push('IPTC');
      } else if (marker === 0xe2 && startsWith(payload, 'ICC_PROFILE\0')) {
        // Keep: colour fidelity, and no personal data.
        out.push([segStart, segEnd]);
        i = segEnd;
        continue;
      } else if (marker === 0xe0 && startsWith(payload, 'JFIF\0')) {
        // Keep: density and thumbnail flags some decoders expect.
        out.push([segStart, segEnd]);
        i = segEnd;
        continue;
      } else {
        removed.push(tag);
      }
      i = segEnd;                              // dropped
      continue;
    }

    out.push([segStart, segEnd]);
    i = segEnd;
  }

  if (removed.length === 0) return { ...unchanged(bytes), orientation, hadGps };
  return { bytes: concatRanges(bytes, out), changed: true, removed, orientation, hadGps };
}

/**
 * Reads orientation and detects a GPS IFD from an EXIF/TIFF block.
 *
 * Deliberately shallow: this walks IFD0 for two tag numbers and does not parse
 * values. Anything more would be a parser for attacker-controlled input, and
 * the block is about to be discarded regardless.
 */
export function readExif(tiff: Uint8Array): { orientation: number | null; hadGps: boolean } {
  if (tiff.length < 8) return { orientation: null, hadGps: false };

  const le = tiff[0] === 0x49 && tiff[1] === 0x49;   // "II" little-endian
  const be = tiff[0] === 0x4d && tiff[1] === 0x4d;   // "MM" big-endian
  if (!le && !be) return { orientation: null, hadGps: false };

  const u16 = (o: number): number =>
    le ? tiff[o]! | (tiff[o + 1]! << 8) : (tiff[o]! << 8) | tiff[o + 1]!;
  const u32 = (o: number): number =>
    le
      ? (tiff[o]! | (tiff[o + 1]! << 8) | (tiff[o + 2]! << 16) | (tiff[o + 3]! << 24)) >>> 0
      : ((tiff[o]! << 24) | (tiff[o + 1]! << 16) | (tiff[o + 2]! << 8) | tiff[o + 3]!) >>> 0;

  const ifd0 = u32(4);
  if (ifd0 + 2 > tiff.length) return { orientation: null, hadGps: false };

  const count = u16(ifd0);
  // A count large enough to run past the buffer is a malformed or hostile
  // file. Bound the loop by the buffer rather than trusting the header.
  const maxEntries = Math.min(count, Math.floor((tiff.length - ifd0 - 2) / 12));

  let orientation: number | null = null;
  let hadGps = false;

  for (let e = 0; e < maxEntries; e++) {
    const entry = ifd0 + 2 + e * 12;
    const tag = u16(entry);
    if (tag === 0x0112) {
      const v = u16(entry + 8);
      if (v >= 1 && v <= 8) orientation = v;
    } else if (tag === 0x8825) {
      hadGps = true;      // a GPS IFD pointer: the photo knows where it was taken
    }
  }
  return { orientation, hadGps };
}

// ── PNG ─────────────────────────────────────────────────────────────────────

/**
 * A PNG is an 8-byte signature followed by chunks: a 4-byte big-endian length,
 * a 4-byte type, the data, and a 4-byte CRC. Dropping a chunk is exact — the
 * CRC covers only that chunk, so nothing else needs recomputing.
 *
 * Text chunks are dropped along with eXIf, because tEXt/iTXt/zTXt are where
 * editors put author names and comments.
 */
const PNG_DROP = new Set(['eXIf', 'tEXt', 'iTXt', 'zTXt', 'tIME']);

export function stripPng(bytes: Uint8Array): StripResult {
  const keep: Array<[number, number]> = [[0, 8]];
  const removed: string[] = [];
  let orientation: number | null = null;
  let hadGps = false;

  let i = 8;
  while (i + 8 <= bytes.length) {
    const len =
      ((bytes[i]! << 24) | (bytes[i + 1]! << 16) | (bytes[i + 2]! << 8) | bytes[i + 3]!) >>> 0;
    const type = ascii(bytes, i + 4, 4);
    const end = i + 12 + len;                 // length + type + data + CRC
    if (end > bytes.length) break;            // truncated

    if (PNG_DROP.has(type)) {
      removed.push(type);
      if (type === 'eXIf') {
        const exif = readExif(bytes.subarray(i + 8, i + 8 + len));
        orientation = exif.orientation;
        hadGps = exif.hadGps;
      }
    } else {
      keep.push([i, end]);
    }
    i = end;
    if (type === 'IEND') break;
  }

  if (removed.length === 0) return unchanged(bytes);
  return { bytes: concatRanges(bytes, keep), changed: true, removed, orientation, hadGps };
}

// ── WebP ────────────────────────────────────────────────────────────────────

/**
 * WebP is a RIFF container: "RIFF", a 4-byte little-endian size, "WEBP", then
 * chunks of a 4-byte type, a 4-byte little-endian size, the data, and a pad
 * byte when the size is odd.
 *
 * Dropping EXIF or XMP means the RIFF size in the header no longer matches, so
 * it is rewritten. A file whose declared size disagrees with its content is
 * rejected by strict decoders.
 */
export function stripWebp(bytes: Uint8Array): StripResult {
  const keep: Array<[number, number]> = [[0, 12]];
  const removed: string[] = [];
  let orientation: number | null = null;
  let hadGps = false;

  let i = 12;
  while (i + 8 <= bytes.length) {
    const type = ascii(bytes, i, 4);
    const size =
      (bytes[i + 4]! | (bytes[i + 5]! << 8) | (bytes[i + 6]! << 16) | (bytes[i + 7]! << 24)) >>> 0;
    const padded = size + (size % 2);
    const end = i + 8 + padded;
    if (end > bytes.length) break;

    if (type === 'EXIF' || type === 'XMP ') {
      removed.push(type.trim());
      if (type === 'EXIF') {
        const exif = readExif(bytes.subarray(i + 8, i + 8 + size));
        orientation = exif.orientation;
        hadGps = exif.hadGps;
      }
    } else {
      keep.push([i, end]);
    }
    i = end;
  }

  if (removed.length === 0) return unchanged(bytes);

  const out = concatRanges(bytes, keep);
  // Rewrite the RIFF size: everything after the first 8 bytes.
  const riffSize = out.length - 8;
  out[4] = riffSize & 0xff;
  out[5] = (riffSize >> 8) & 0xff;
  out[6] = (riffSize >> 16) & 0xff;
  out[7] = (riffSize >> 24) & 0xff;

  return { bytes: out, changed: true, removed, orientation, hadGps };
}

// ── helpers ─────────────────────────────────────────────────────────────────

function startsWith(b: Uint8Array, prefix: string): boolean {
  if (b.length < prefix.length) return false;
  for (let i = 0; i < prefix.length; i++) {
    if (b[i] !== prefix.charCodeAt(i)) return false;
  }
  return true;
}

function concatRanges(src: Uint8Array, ranges: ReadonlyArray<[number, number]>): Uint8Array {
  let total = 0;
  for (const [a, b] of ranges) total += b - a;
  const out = new Uint8Array(total);
  let at = 0;
  for (const [a, b] of ranges) {
    out.set(src.subarray(a, b), at);
    at += b - a;
  }
  return out;
}

/**
 * Whether a file still carries metadata worth removing.
 *
 * Cheap enough to run over just the head of an object, which is how the
 * completion path avoids downloading whole images: browser-side compression
 * re-encodes through a canvas and drops all metadata as a side effect, so the
 * common case is a short range read that finds nothing and stops there.
 */
export function hasMetadata(head: Uint8Array): boolean {
  const kind = sniffImage(head);
  if (kind === 'jpeg') {
    // Look for an APPn or COM marker in the head. APP0/JFIF and APP2/ICC are
    // kept, so their presence alone is not a reason to rewrite the file.
    let i = 2;
    while (i + 4 < head.length) {
      if (head[i] !== 0xff) return false;
      const marker = head[i + 1]!;
      if (marker === 0xda) return false;
      const len = (head[i + 2]! << 8) | head[i + 3]!;
      if (len < 2) return false;
      const payload = head.subarray(i + 4, Math.min(i + 2 + len, head.length));
      const keepable =
        (marker === 0xe0 && startsWith(payload, 'JFIF\0')) ||
        (marker === 0xe2 && startsWith(payload, 'ICC_PROFILE\0'));
      if ((marker >= 0xe0 && marker <= 0xef) || marker === 0xfe) {
        if (!keepable) return true;
      }
      i += 2 + len;
    }
    return false;
  }
  if (kind === 'png') {
    let i = 8;
    while (i + 8 <= head.length) {
      const len =
        ((head[i]! << 24) | (head[i + 1]! << 16) | (head[i + 2]! << 8) | head[i + 3]!) >>> 0;
      const type = ascii(head, i + 4, 4);
      if (PNG_DROP.has(type)) return true;
      // IDAT onwards is pixel data; text chunks after it are rare and the
      // full strip will catch them if the head suggested nothing.
      if (type === 'IDAT' || type === 'IEND') return false;
      i += 12 + len;
    }
    return false;
  }
  if (kind === 'webp') {
    let i = 12;
    while (i + 8 <= head.length) {
      const type = ascii(head, i, 4);
      if (type === 'EXIF' || type === 'XMP ') return true;
      const size =
        (head[i + 4]! | (head[i + 5]! << 8) | (head[i + 6]! << 16) | (head[i + 7]! << 24)) >>> 0;
      i += 8 + size + (size % 2);
    }
    return false;
  }
  return false;
}
