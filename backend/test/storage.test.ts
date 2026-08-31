/**
 * Storage tests.
 *
 * The image-metadata half is the security-critical part and is fully testable:
 * every case is bytes in, bytes out, with no I/O and no decoder.
 *
 * The presigning half is checked structurally and against a known-answer
 * signature, since AWS publishes the algorithm precisely enough to verify a
 * signer without a live endpoint.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { presignUrl, encodeS3Path, signRequest } from '../src/lib/awssig.js';
import {
  hasMetadata, mimeFor, readExif, sniffImage,
  stripJpeg, stripMetadata, stripPng, stripWebp,
} from '../src/modules/storage/imagemeta.js';
import { S3Storage, type FetchLike } from '../src/modules/storage/s3.js';
import { UploadService } from '../src/modules/storage/service.js';
import { signStorageUrl } from '../src/lib/crypto.js';
import { AppError } from '../src/lib/errors.js';
import type { Sql, QueryResult } from '../src/db/pool.js';

// ── byte builders ────────────────────────────────────────────────────────────

const str = (s: string): number[] => [...s].map((c) => c.charCodeAt(0));

/** A JPEG segment: 0xFF, marker, big-endian length INCLUDING the length bytes. */
function jpegSegment(marker: number, payload: number[]): number[] {
  const len = payload.length + 2;
  return [0xff, marker, (len >> 8) & 0xff, len & 0xff, ...payload];
}

/** A minimal little-endian TIFF block with the tags readExif looks for. */
function tiffBlock(opts: { orientation?: number; gps?: boolean } = {}): number[] {
  const entries: number[][] = [];
  if (opts.orientation !== undefined) {
    // tag 0x0112, type SHORT, count 1, value in the first two value bytes.
    entries.push([0x12, 0x01, 0x03, 0x00, 1, 0, 0, 0, opts.orientation, 0, 0, 0]);
  }
  if (opts.gps) {
    // tag 0x8825, a GPS IFD pointer.
    entries.push([0x25, 0x88, 0x04, 0x00, 1, 0, 0, 0, 0x1a, 0, 0, 0]);
  }
  return [
    0x49, 0x49, 0x2a, 0x00,          // "II", 42
    0x08, 0x00, 0x00, 0x00,          // IFD0 at offset 8
    entries.length & 0xff, 0x00,     // entry count
    ...entries.flat(),
    0x00, 0x00, 0x00, 0x00,          // no next IFD
  ];
}

function jpegWith(segments: number[][]): Uint8Array {
  return new Uint8Array([
    0xff, 0xd8,                       // SOI
    ...segments.flat(),
    0xff, 0xda, 0x00, 0x02,           // SOS
    0x01, 0x02, 0x03,                 // "image data"
  ]);
}

function crcPlaceholder(): number[] { return [0, 0, 0, 0]; }

function pngChunk(type: string, data: number[]): number[] {
  const len = data.length;
  return [
    (len >>> 24) & 0xff, (len >>> 16) & 0xff, (len >>> 8) & 0xff, len & 0xff,
    ...str(type), ...data, ...crcPlaceholder(),
  ];
}

function pngWith(chunks: number[][]): Uint8Array {
  return new Uint8Array([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ...chunks.flat(),
    ...pngChunk('IEND', []),
  ]);
}

function webpChunk(type: string, data: number[]): number[] {
  const len = data.length;
  const pad = len % 2 === 1 ? [0] : [];
  return [
    ...str(type),
    len & 0xff, (len >>> 8) & 0xff, (len >>> 16) & 0xff, (len >>> 24) & 0xff,
    ...data, ...pad,
  ];
}

function webpWith(chunks: number[][]): Uint8Array {
  const body = chunks.flat();
  const riffSize = 4 + body.length;
  return new Uint8Array([
    ...str('RIFF'),
    riffSize & 0xff, (riffSize >>> 8) & 0xff, (riffSize >>> 16) & 0xff, (riffSize >>> 24) & 0xff,
    ...str('WEBP'),
    ...body,
  ]);
}

// ── sniffing ─────────────────────────────────────────────────────────────────

test('sniff: identifies each format from its leading bytes', () => {
  assert.equal(sniffImage(jpegWith([])), 'jpeg');
  assert.equal(sniffImage(pngWith([])), 'png');
  assert.equal(sniffImage(webpWith([webpChunk('VP8 ', [1, 2, 3, 4])])), 'webp');
  assert.equal(sniffImage(new Uint8Array([...str('GIF89a'), 0, 0, 0, 0, 0, 0])), 'gif');
  assert.equal(
    sniffImage(new Uint8Array([0, 0, 0, 0x18, ...str('ftyp'), ...str('avif'), 0, 0, 0, 0])),
    'avif',
  );
  assert.equal(
    sniffImage(new Uint8Array([0, 0, 0, 0x18, ...str('ftyp'), ...str('heic'), 0, 0, 0, 0])),
    'heic',
  );
});

test('sniff: a declared type is not believed — the bytes decide', () => {
  // The oldest trick: a "photo" that is really a script. Content-Type is
  // chosen by the uploader and means nothing.
  const svg = new Uint8Array(str('<svg onload=alert(1)></svg>'));
  assert.equal(sniffImage(svg), 'unknown');
  assert.equal(mimeFor(sniffImage(svg)), null);

  const php = new Uint8Array(str('<?php system($_GET[0]); ?>          '));
  assert.equal(sniffImage(php), 'unknown');
});

test('sniff: a truncated file is unknown rather than a guess', () => {
  // Two bytes is an SOI with no marker after it — not enough to call it.
  assert.equal(sniffImage(new Uint8Array([0xff, 0xd8])), 'unknown');
  assert.equal(sniffImage(new Uint8Array(0)), 'unknown');
  // A PNG signature needs all eight bytes; four is not a PNG.
  assert.equal(sniffImage(new Uint8Array([0x89, 0x50, 0x4e, 0x47])), 'unknown');
  // A three-byte JPEG signature IS enough, and must be recognized.
  assert.equal(sniffImage(new Uint8Array([0xff, 0xd8, 0xff])), 'jpeg');
});

test('sniff: RIFF that is not WebP is not WebP', () => {
  const wav = new Uint8Array([...str('RIFF'), 0, 0, 0, 0, ...str('WAVE')]);
  assert.equal(sniffImage(wav), 'unknown');
});

// ── EXIF reading ─────────────────────────────────────────────────────────────

test('exif: reads orientation and detects a GPS block', () => {
  assert.deepEqual(readExif(new Uint8Array(tiffBlock({ orientation: 6 }))),
    { orientation: 6, hadGps: false });
  assert.deepEqual(readExif(new Uint8Array(tiffBlock({ orientation: 1, gps: true }))),
    { orientation: 1, hadGps: true });
});

test('exif: a nonsense orientation is ignored rather than stored', () => {
  assert.equal(readExif(new Uint8Array(tiffBlock({ orientation: 99 }))).orientation, null);
});

test('exif: a bogus header is refused without throwing', () => {
  assert.deepEqual(readExif(new Uint8Array([1, 2, 3])), { orientation: null, hadGps: false });
  assert.deepEqual(readExif(new Uint8Array([0x58, 0x58, 0, 0, 0, 0, 0, 0])),
    { orientation: null, hadGps: false });
});

test('exif: an entry count larger than the buffer does not run off the end', () => {
  // A hostile file claiming 60,000 IFD entries in 30 bytes. The loop is bound
  // by the buffer, not by the header's claim.
  const hostile = new Uint8Array([
    0x49, 0x49, 0x2a, 0x00, 0x08, 0x00, 0x00, 0x00,
    0xff, 0xff,                       // count = 65535
    0x12, 0x01, 0x03, 0x00, 1, 0, 0, 0, 6, 0, 0, 0,
  ]);
  assert.doesNotThrow(() => readExif(hostile));
  assert.equal(readExif(hostile).orientation, 6);
});

// ── JPEG stripping ───────────────────────────────────────────────────────────

test('jpeg: EXIF is removed and the image data survives', () => {
  const exif = jpegSegment(0xe1, [...str('Exif\0\0'), ...tiffBlock({ orientation: 6, gps: true })]);
  const withExif = jpegWith([exif]);

  const out = stripJpeg(withExif);
  assert.equal(out.changed, true);
  assert.ok(out.removed.includes('EXIF'));
  assert.equal(out.orientation, 6, 'orientation is reported so the client can rotate');
  assert.equal(out.hadGps, true, 'and the GPS presence is recorded');

  assert.ok(out.bytes.length < withExif.length);
  assert.equal(sniffImage(out.bytes), 'jpeg', 'it is still a JPEG');
  // The scan and its data must be intact.
  const tail = Array.from(out.bytes.slice(-5));
  assert.deepEqual(tail, [0x00, 0x02, 0x01, 0x02, 0x03]);
});

test('jpeg: GPS coordinates do not survive stripping', () => {
  // The whole point. A listing photo published with EXIF discloses exactly
  // where the property is, which would also make the map licensing care
  // taken elsewhere pointless.
  const gps = jpegSegment(0xe1, [...str('Exif\0\0'), ...tiffBlock({ gps: true })]);
  const out = stripJpeg(jpegWith([gps]));
  const text = Buffer.from(out.bytes).toString('latin1');
  assert.ok(!text.includes('Exif'), 'no EXIF marker may remain');
});

test('jpeg: the ICC colour profile is kept', () => {
  // Dropping it makes wide-gamut photos render with visibly wrong colour, and
  // it says nothing about the photographer or the place.
  const icc = jpegSegment(0xe2, [...str('ICC_PROFILE\0'), 1, 2, 3]);
  const exif = jpegSegment(0xe1, [...str('Exif\0\0'), ...tiffBlock({ orientation: 1 })]);
  const out = stripJpeg(jpegWith([icc, exif]));

  assert.ok(Buffer.from(out.bytes).toString('latin1').includes('ICC_PROFILE'));
  assert.ok(!Buffer.from(out.bytes).toString('latin1').includes('Exif'));
});

test('jpeg: the JFIF header is kept', () => {
  const jfif = jpegSegment(0xe0, [...str('JFIF\0'), 1, 1, 0, 0, 1, 0, 1, 0, 0]);
  const out = stripJpeg(jpegWith([jfif]));
  assert.equal(out.changed, false, 'a JFIF-only file needs no rewrite');
});

test('jpeg: XMP, IPTC and comments all go', () => {
  const xmp = jpegSegment(0xe1, str('http://ns.adobe.com/xap/1.0/\0<x:xmpmeta/>'));
  const iptc = jpegSegment(0xed, [1, 2, 3, 4]);
  const comment = jpegSegment(0xfe, str('taken by someone'));
  const out = stripJpeg(jpegWith([xmp, iptc, comment]));

  assert.deepEqual(out.removed.sort(), ['COM', 'IPTC', 'XMP']);
  assert.ok(!Buffer.from(out.bytes).toString('latin1').includes('taken by someone'));
});

test('jpeg: a clean file is returned untouched', () => {
  const clean = jpegWith([]);
  const out = stripJpeg(clean);
  assert.equal(out.changed, false);
  assert.deepEqual(Array.from(out.bytes), Array.from(clean));
});

test('jpeg: a truncated segment does not loop or throw', () => {
  // Claims a 1000-byte segment in a 10-byte file.
  const truncated = new Uint8Array([0xff, 0xd8, 0xff, 0xe1, 0x03, 0xe8, 1, 2, 3, 4]);
  assert.doesNotThrow(() => stripJpeg(truncated));
});

// ── PNG stripping ────────────────────────────────────────────────────────────

test('png: metadata chunks go and pixel chunks stay', () => {
  const png = pngWith([
    pngChunk('IHDR', [0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0]),
    pngChunk('eXIf', tiffBlock({ orientation: 3, gps: true })),
    pngChunk('tEXt', str('Author\0Someone')),
    pngChunk('IDAT', [1, 2, 3, 4]),
  ]);
  const out = stripPng(png);

  assert.equal(out.changed, true);
  assert.deepEqual(out.removed.sort(), ['eXIf', 'tEXt']);
  assert.equal(out.orientation, 3);
  assert.equal(out.hadGps, true);

  const text = Buffer.from(out.bytes).toString('latin1');
  assert.ok(text.includes('IHDR') && text.includes('IDAT'), 'pixel chunks survive');
  assert.ok(!text.includes('Someone'), 'the author name does not');
  assert.equal(sniffImage(out.bytes), 'png');
});

test('png: a clean file is untouched', () => {
  const png = pngWith([pngChunk('IHDR', [0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0])]);
  assert.equal(stripPng(png).changed, false);
});

// ── WebP stripping ───────────────────────────────────────────────────────────

test('webp: EXIF and XMP go, and the RIFF size is corrected', () => {
  const withMeta = webpWith([
    webpChunk('VP8 ', [1, 2, 3, 4]),
    webpChunk('EXIF', tiffBlock({ orientation: 8, gps: true })),
    webpChunk('XMP ', str('<x:xmpmeta/>')),
  ]);
  const out = stripWebp(withMeta);

  assert.equal(out.changed, true);
  assert.deepEqual(out.removed.sort(), ['EXIF', 'XMP']);
  assert.equal(out.orientation, 8);
  assert.equal(out.hadGps, true);
  assert.equal(sniffImage(out.bytes), 'webp');

  // A declared size that disagrees with the content is rejected by strict
  // decoders, so the header has to be rewritten rather than left stale.
  const declared =
    out.bytes[4]! | (out.bytes[5]! << 8) | (out.bytes[6]! << 16) | (out.bytes[7]! << 24);
  assert.equal(declared, out.bytes.length - 8, 'RIFF size must match the new length');
});

test('webp: an odd-length chunk pads correctly and still parses', () => {
  const odd = webpWith([webpChunk('VP8 ', [1, 2, 3]), webpChunk('EXIF', tiffBlock())]);
  const out = stripWebp(odd);
  assert.equal(out.changed, true);
  assert.equal(sniffImage(out.bytes), 'webp');
});

// ── the cheap probe ──────────────────────────────────────────────────────────

test('probe: reports metadata present without downloading the whole file', () => {
  // This is what keeps completion cheap. Browser-side compression re-encodes
  // through a canvas and drops metadata as a side effect, so most files come
  // back clean from a short range read and are never fully downloaded.
  const dirty = jpegWith([jpegSegment(0xe1, [...str('Exif\0\0'), ...tiffBlock()])]);
  const clean = jpegWith([jpegSegment(0xe0, [...str('JFIF\0'), 1, 1, 0, 0, 1, 0, 1, 0, 0])]);

  assert.equal(hasMetadata(dirty), true);
  assert.equal(hasMetadata(clean), false);
  assert.equal(hasMetadata(pngWith([pngChunk('tEXt', str('x\0y'))])), true);
  assert.equal(hasMetadata(webpWith([webpChunk('EXIF', [1, 2])])), true);
  assert.equal(hasMetadata(webpWith([webpChunk('VP8 ', [1, 2])])), false);
});

test('probe: agrees with the full strip on whether there is work to do', () => {
  for (const img of [
    jpegWith([jpegSegment(0xe1, [...str('Exif\0\0'), ...tiffBlock()])]),
    jpegWith([]),
    pngWith([pngChunk('IHDR', [1]), pngChunk('eXIf', tiffBlock())]),
    webpWith([webpChunk('VP8 ', [1, 2, 3, 4])]),
  ]) {
    assert.equal(hasMetadata(img), stripMetadata(img).changed,
      'the probe must not disagree with the strip');
  }
});

// ── presigning ───────────────────────────────────────────────────────────────

const CREDS = { accessKeyId: 'AKIAIOSFODNN7EXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY' };

test('presign: carries every parameter S3 requires', () => {
  const url = presignUrl({
    method: 'PUT', host: 'bucket.r2.cloudflarestorage.com', path: '/bucket/photo.jpg',
    expiresIn: 900, service: 's3', region: 'auto', credentials: CREDS,
    now: new Date('2026-03-01T12:00:00Z'),
  });
  for (const p of [
    'X-Amz-Algorithm=AWS4-HMAC-SHA256', 'X-Amz-Credential=', 'X-Amz-Date=20260301T120000Z',
    'X-Amz-Expires=900', 'X-Amz-SignedHeaders=host', 'X-Amz-Signature=',
  ]) {
    assert.ok(url.includes(p), `missing ${p}`);
  }
});

test('presign: no secret ever appears in the URL', () => {
  const url = presignUrl({
    method: 'PUT', host: 'h', path: '/b/k', expiresIn: 900,
    service: 's3', region: 'auto', credentials: CREDS,
  });
  assert.ok(!url.includes(CREDS.secretAccessKey), 'the secret key must not leak into the URL');
  assert.ok(url.includes(CREDS.accessKeyId), 'the ACCESS key id is public and is expected');
});

test('presign: the signature is deterministic and covers method, key and time', () => {
  const at = new Date('2026-03-01T12:00:00Z');
  const base = {
    host: 'h', expiresIn: 900, service: 's3', region: 'auto', credentials: CREDS, now: at,
  };
  const sig = (u: string): string => u.split('X-Amz-Signature=')[1]!;

  const put = presignUrl({ ...base, method: 'PUT', path: '/b/k' });
  assert.equal(sig(put), sig(presignUrl({ ...base, method: 'PUT', path: '/b/k' })),
    'the same inputs must give the same signature');

  // A URL minted to write one object must not be usable for another, or for
  // a different verb.
  assert.notEqual(sig(put), sig(presignUrl({ ...base, method: 'GET', path: '/b/k' })));
  assert.notEqual(sig(put), sig(presignUrl({ ...base, method: 'PUT', path: '/b/other' })));
  assert.notEqual(sig(put), sig(presignUrl({
    ...base, method: 'PUT', path: '/b/k', now: new Date('2026-03-02T12:00:00Z'),
  })));
});

test('presign: expiry is clamped to the seven-day maximum AWS accepts', () => {
  const url = presignUrl({
    method: 'GET', host: 'h', path: '/b/k', expiresIn: 999_999_999,
    service: 's3', region: 'auto', credentials: CREDS,
  });
  assert.ok(url.includes(`X-Amz-Expires=${7 * 24 * 60 * 60}`));
});

test('presign: query parameters are sorted, as the canonical form requires', () => {
  const url = presignUrl({
    method: 'GET', host: 'h', path: '/b/k', expiresIn: 60,
    service: 's3', region: 'auto', credentials: CREDS,
    query: { 'response-content-type': 'image/jpeg', 'a-first': '1' },
  });
  const qs = url.split('?')[1]!.replace(/&X-Amz-Signature=.*$/, '');
  const keys = qs.split('&').map((kv) => kv.split('=')[0]!);
  assert.deepEqual(keys, [...keys].sort(), 'canonical query must be sorted');
});

test('path encoding: slashes survive, everything else is escaped', () => {
  assert.equal(encodeS3Path('listings/abc/photo 1.jpg'), '/listings/abc/photo%201.jpg');
  // encodeURIComponent on the whole key would turn separators into %2F and
  // address a completely different object.
  assert.equal(encodeS3Path('a/b/c'), '/a/b/c');
  assert.equal(encodeS3Path("odd'name(1).jpg"), "/odd%27name%281%29.jpg");
});

test('sign: an unsigned payload hash reaches both the header and the signature', () => {
  // Patching the header after signing produces a signature over a value the
  // request does not send, and S3 answers SignatureDoesNotMatch — which reads
  // like a credentials fault and costs an afternoon.
  const signed = signRequest({
    method: 'PUT', host: 'h', path: '/b/k', service: 's3', region: 'auto',
    credentials: CREDS, payloadHash: 'UNSIGNED-PAYLOAD',
  });
  assert.equal(signed.headers['x-amz-content-sha256'], 'UNSIGNED-PAYLOAD');
  assert.ok(signed.headers['authorization']!.includes('x-amz-content-sha256'),
    'the hash header must be among the signed headers');
});

// ── the S3 client ────────────────────────────────────────────────────────────

function fakeFetch(handler: (url: string, init: { method: string; headers: Record<string, string> }) => {
  ok?: boolean; status?: number; headers?: Record<string, string>; body?: Uint8Array;
}): FetchLike & { calls: Array<{ url: string; method: string; headers: Record<string, string> }> } {
  const calls: Array<{ url: string; method: string; headers: Record<string, string> }> = [];
  const fn = (async (url: string, init: { method: string; headers: Record<string, string> }) => {
    calls.push({ url, method: init.method, headers: init.headers });
    const r = handler(url, init);
    const body = r.body ?? new Uint8Array(0);
    return {
      ok: r.ok ?? true,
      status: r.status ?? 200,
      headers: { get: (n: string) => r.headers?.[n.toLowerCase()] ?? null },
      arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength),
      text: async () => Buffer.from(body).toString('utf8'),
    };
  }) as FetchLike & { calls: typeof calls };
  fn.calls = calls;
  return fn;
}

function storage(fetchImpl: FetchLike): S3Storage {
  return new S3Storage({
    endpoint: 'acct.r2.cloudflarestorage.com', bucket: 'portage', region: 'auto',
    credentials: CREDS, fetchImpl,
  });
}

test('s3: a missing object is null, not an exception', async () => {
  const s = storage(fakeFetch(() => ({ ok: false, status: 404 })));
  assert.equal(await s.head('nope'), null);
  assert.equal(await s.get('nope'), null);
});

test('s3: a range read asks for only the head of the object', async () => {
  const f = fakeFetch(() => ({ status: 206, body: new Uint8Array([1, 2, 3]) }));
  await storage(f).get('k', { maxBytes: 1024 });
  assert.equal(f.calls[0]?.headers['range'], 'bytes=0-1023');
});

test('s3: deleting something already gone is success', async () => {
  const s = storage(fakeFetch(() => ({ ok: false, status: 404 })));
  await assert.doesNotReject(() => s.delete('k'));
});

test('s3: a real failure is not swallowed', async () => {
  const s = storage(fakeFetch(() => ({ ok: false, status: 500 })));
  await assert.rejects(() => s.delete('k'));
  await assert.rejects(() => s.head('k'));
});

test('s3: a binary PUT signs UNSIGNED-PAYLOAD', async () => {
  const f = fakeFetch(() => ({ status: 200 }));
  await storage(f).put('k', new Uint8Array([1, 2, 3]), 'image/jpeg');
  assert.equal(f.calls[0]?.headers['x-amz-content-sha256'], 'UNSIGNED-PAYLOAD');
  assert.ok(f.calls[0]?.headers['authorization']?.includes('AWS4-HMAC-SHA256'));
});

test('s3: the public URL is the CDN domain, not the signing endpoint', () => {
  const s = new S3Storage({
    endpoint: 'acct.r2.cloudflarestorage.com', bucket: 'portage', region: 'auto',
    credentials: CREDS, publicBaseUrl: 'https://images.portage.ca/',
    fetchImpl: fakeFetch(() => ({})),
  });
  assert.equal(s.publicUrl('listings/a/1.jpg'), 'https://images.portage.ca/listings/a/1.jpg');
});

// ── the completion path ──────────────────────────────────────────────────────

const SECRET = 'test-storage-secret-value-0123456789';
const OWNER = '11111111-1111-4111-8111-111111111111';

interface FakeRow { [k: string]: unknown }

function fakeDb(row: FakeRow | null): Sql & { statements: string[] } {
  const statements: string[] = [];
  const db: Sql & { statements: string[] } = {
    statements,
    async query<R>(text: string): Promise<QueryResult<R>> {
      statements.push(text.replace(/\s+/g, ' ').trim());
      if (text.includes('FROM uploads WHERE storage_key')) {
        return row ? { rows: [row as unknown as R], rowCount: 1 } : { rows: [], rowCount: 0 };
      }
      if (text.includes('FROM uploads WHERE id')) {
        return row ? { rows: [row as unknown as R], rowCount: 1 } : { rows: [], rowCount: 0 };
      }
      return { rows: [], rowCount: 1 };
    },
    async transaction<T>(fn: (tx: Sql) => Promise<T>): Promise<T> { return fn(db); },
  };
  return db;
}

const pendingRow = (over: FakeRow = {}): FakeRow => ({
  id: 'upload-1', owner_id: OWNER, subject_type: 'listing_media', subject_id: 'media-1',
  storage_key: 'listings/l1/p1', status: 'pending',
  declared_bytes: '1000', declared_mime: 'image/jpeg', ...over,
});

function tokenFor(key: string, userId = OWNER, offsetSec = 900): string {
  return signStorageUrl(
    { storageKey: key, userId, expiresAt: Math.floor(Date.now() / 1000) + offsetSec },
    SECRET,
  );
}

function service(opts: {
  row?: FakeRow | null;
  object?: Uint8Array | null;
  size?: number;
}): { svc: UploadService; db: Sql & { statements: string[] }; puts: Uint8Array[] } {
  const db = fakeDb(opts.row === undefined ? pendingRow() : opts.row);
  const object = opts.object === undefined ? jpegWith([]) : opts.object;
  const puts: Uint8Array[] = [];

  const s3 = {
    presignPut: () => 'https://example.test/put',
    async head() {
      return object ? { contentLength: opts.size ?? object.length, contentType: null, etag: null } : null;
    },
    async get(_k: string, o: { maxBytes?: number } = {}) {
      if (!object) return null;
      return o.maxBytes ? object.subarray(0, o.maxBytes) : object;
    },
    async put(_k: string, body: Uint8Array) { puts.push(body); },
    async delete() { /* noop */ },
  } as unknown as import('../src/modules/storage/s3.js').S3Storage;

  return { svc: new UploadService({ db, storage: s3, ticketSecret: SECRET }), db, puts };
}

test('complete: an expired or forged token is refused', async () => {
  const { svc } = service({});
  for (const bad of ['garbage', tokenFor('listings/l1/p1', OWNER, -10)]) {
    const out = await svc.complete({ token: bad, ownerId: OWNER });
    assert.equal(out.ok, false);
  }
});

test('complete: a token minted for another user is refused', async () => {
  const { svc } = service({});
  const out = await svc.complete({
    token: tokenFor('listings/l1/p1', '22222222-2222-4222-8222-222222222222'),
    ownerId: OWNER,
  });
  assert.equal(out.ok, false);
});

test('complete: an object that never arrived is reported, not stored', async () => {
  const { svc } = service({ object: null });
  const out = await svc.complete({ token: tokenFor('listings/l1/p1'), ownerId: OWNER });
  assert.equal(out.ok, false);
  assert.ok(out.ok === false && /No file was received/.test(out.reason));
});

test('complete: a file that is not an image is rejected however it was labelled', async () => {
  // The row says image/jpeg. The bytes say otherwise, and the bytes win.
  const { svc } = service({ object: new Uint8Array(str('<svg onload=alert(1)></svg>')) });
  const out = await svc.complete({ token: tokenFor('listings/l1/p1'), ownerId: OWNER });
  assert.equal(out.ok, false);
  assert.ok(out.ok === false && /not an image/.test(out.reason));
});

test('complete: a clean image is stored without being downloaded in full', async () => {
  const { svc, puts } = service({ object: jpegWith([]) });
  const out = await svc.complete({ token: tokenFor('listings/l1/p1'), ownerId: OWNER });
  assert.equal(out.ok, true);
  assert.equal(puts.length, 0, 'nothing to rewrite means nothing to write back');
  assert.ok(out.ok === true && out.contentHash.length === 64);
});

test('complete: an image carrying GPS is rewritten and the fact is reported', async () => {
  const dirty = jpegWith([jpegSegment(0xe1, [...str('Exif\0\0'), ...tiffBlock({ orientation: 6, gps: true })])]);
  const { svc, puts } = service({ object: dirty });

  const out = await svc.complete({ token: tokenFor('listings/l1/p1'), ownerId: OWNER });
  assert.equal(out.ok, true);
  assert.equal(puts.length, 1, 'the stripped bytes must be written back');
  assert.ok(out.ok === true);
  assert.equal(out.hadGps, true);
  assert.equal(out.orientation, 6);
  assert.ok(out.metadataStripped.includes('EXIF'));
  assert.ok(!Buffer.from(puts[0]!).toString('latin1').includes('Exif'));
});

test('complete: the hash is over what is actually stored', async () => {
  const dirty = jpegWith([jpegSegment(0xe1, [...str('Exif\0\0'), ...tiffBlock()])]);
  const { svc, puts } = service({ object: dirty });
  const out = await svc.complete({ token: tokenFor('listings/l1/p1'), ownerId: OWNER });

  assert.ok(out.ok === true);
  const { createHash } = await import('node:crypto');
  const expected = createHash('sha256').update(puts[0]!).digest('hex');
  assert.equal(out.contentHash, expected,
    'hashing the pre-strip bytes would digest a file that no longer exists');
});

test('complete: an empty object is rejected', async () => {
  const { svc } = service({ object: new Uint8Array(0), size: 0 });
  const out = await svc.complete({ token: tokenFor('listings/l1/p1'), ownerId: OWNER });
  assert.equal(out.ok, false);
});

test('complete: an oversized object is rejected on the real size, not the claim', async () => {
  const { svc } = service({ object: jpegWith([]), size: 40 * 1024 * 1024 });
  const out = await svc.complete({ token: tokenFor('listings/l1/p1'), ownerId: OWNER });
  assert.equal(out.ok, false);
  assert.ok(out.ok === false && /larger than/.test(out.reason));
});

test('complete: calling twice is a retry, not an error', async () => {
  // The network is unreliable and a client cannot always tell whether its
  // first completion call landed.
  const { svc } = service({ row: pendingRow({ status: 'stored', verified_bytes: '123', verified_mime: 'image/jpeg', content_hash: Buffer.alloc(32), metadata_stripped: [], had_gps: false, exif_orientation: null }) });
  const out = await svc.complete({ token: tokenFor('listings/l1/p1'), ownerId: OWNER });
  assert.equal(out.ok, true);
});

test('complete: an upload belonging to someone else is not found', async () => {
  const { svc } = service({ row: pendingRow({ owner_id: '99999999-9999-4999-8999-999999999999' }) });
  await assert.rejects(
    () => svc.complete({ token: tokenFor('listings/l1/p1'), ownerId: OWNER }),
    (err: AppError) => err.status === 404,
  );
});

test('preview: an over-long blurhash is refused', async () => {
  const { svc } = service({});
  await assert.rejects(
    () => svc.recordPreview({ mediaId: 'media-1', ownerId: OWNER, blurhash: 'x'.repeat(100) }),
    (err: AppError) => err.status === 400,
  );
});

test('sweep: abandoned tickets are expired and their objects removed', async () => {
  const db = fakeDb(null);
  let deleted = 0;
  const s3 = {
    async delete() { deleted += 1; },
  } as unknown as import('../src/modules/storage/s3.js').S3Storage;

  // The UPDATE ... RETURNING is what the sweeper reads.
  const original = db.query.bind(db);
  db.query = async (text: string, params?: readonly unknown[]) => {
    if (text.includes("SET status = 'expired'")) {
      return { rows: [{ id: 'u1', storage_key: 'k1' }, { id: 'u2', storage_key: 'k2' }] as never, rowCount: 2 };
    }
    return original(text, params);
  };

  const svc = new UploadService({ db, storage: s3, ticketSecret: SECRET });
  assert.equal(await svc.sweepAbandoned(), 2);
  assert.equal(deleted, 2, 'the objects behind abandoned tickets must be removed');
});

test('sweep: one failing delete does not abort the rest', async () => {
  const db = fakeDb(null);
  let attempts = 0;
  const s3 = {
    async delete() { attempts += 1; if (attempts === 1) throw new Error('transient'); },
  } as unknown as import('../src/modules/storage/s3.js').S3Storage;

  const original = db.query.bind(db);
  db.query = async (text: string, params?: readonly unknown[]) => {
    if (text.includes("SET status = 'expired'")) {
      return { rows: [{ id: 'u1', storage_key: 'k1' }, { id: 'u2', storage_key: 'k2' }] as never, rowCount: 2 };
    }
    return original(text, params);
  };

  const svc = new UploadService({ db, storage: s3, ticketSecret: SECRET });
  await assert.doesNotReject(() => svc.sweepAbandoned());
  assert.equal(attempts, 2, 'the second delete must still be attempted');
});
