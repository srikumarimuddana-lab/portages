/**
 * MapKit token tests.
 *
 * The signature conversion (DER -> JOSE r‖s) is the part most likely to be
 * subtly wrong, so these verify a real signature round-trip against a
 * generated P-256 key rather than just checking the token's shape.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, createVerify, type KeyObject } from 'node:crypto';

import {
  MapKitTokenIssuer,
  decodeUnverified,
  derToJoseP256,
  DEFAULT_TTL_SECONDS,
  MAX_TTL_SECONDS,
} from '../src/modules/maps/mapkit.js';

const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const PEM = privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;
const TEAM = 'ABCDE12345';
const KEY = 'FGHIJ67890';

function issuer() {
  return new MapKitTokenIssuer({ teamId: TEAM, keyId: KEY, privateKeyPem: PEM });
}

/** Verifies an ES256 JWT by converting r‖s back to the DER form Node expects. */
function verifyEs256(token: string, pub: KeyObject): boolean {
  const [h, p, s] = token.split('.') as [string, string, string];
  const jose = Buffer.from(s, 'base64url');
  if (jose.length !== 64) return false;
  const toDerInt = (b: Buffer): Buffer => {
    let i = 0;
    while (i < b.length - 1 && b[i] === 0) i++;
    let v = b.subarray(i);
    if ((v[0]! & 0x80) !== 0) v = Buffer.concat([Buffer.from([0]), v]);
    return Buffer.concat([Buffer.from([0x02, v.length]), v]);
  };
  const r = toDerInt(jose.subarray(0, 32));
  const sPart = toDerInt(jose.subarray(32));
  const body = Buffer.concat([r, sPart]);
  const der = Buffer.concat([Buffer.from([0x30, body.length]), body]);
  return createVerify('SHA256').update(`${h}.${p}`).verify(pub, der);
}

test('mapkit: issues a verifiable ES256 signature', () => {
  const { token } = issuer().issue({ origin: 'https://portage.ca' });
  assert.equal(token.split('.').length, 3);
  assert.equal(verifyEs256(token, publicKey), true);
});

test('mapkit: header carries alg ES256 and the key id', () => {
  const { token } = issuer().issue();
  const { header } = decodeUnverified(token) as { header: Record<string, string> };
  assert.equal(header['alg'], 'ES256');
  assert.equal(header['kid'], KEY);
  assert.equal(header['typ'], 'JWT');
});

test('mapkit: payload carries team id, iat, exp and origin', () => {
  const now = 1_800_000_000;
  const { token, expiresAt } = issuer().issue({ origin: 'https://portage.ca' }, now);
  const { payload } = decodeUnverified(token) as { payload: Record<string, unknown> };
  assert.equal(payload['iss'], TEAM);
  assert.equal(payload['iat'], now);
  assert.equal(payload['exp'], now + DEFAULT_TTL_SECONDS);
  assert.equal(payload['origin'], 'https://portage.ca');
  assert.equal(expiresAt, now + DEFAULT_TTL_SECONDS);
});

test('mapkit: origin claim is omitted when not configured', () => {
  const { token } = issuer().issue();
  const { payload } = decodeUnverified(token) as { payload: Record<string, unknown> };
  assert.equal('origin' in payload, false);
});

test('mapkit: the private key never appears in the token', () => {
  const { token } = issuer().issue();
  assert.ok(!token.includes('PRIVATE KEY'));
  const keyBody = PEM.replace(/-----[A-Z ]+-----/g, '').replace(/\s/g, '');
  assert.ok(!token.includes(keyBody.slice(0, 40)));
});

test('mapkit: signatures differ per issuance (ECDSA is randomized)', () => {
  const i = issuer();
  const a = i.issue({}, 1_800_000_000).token;
  const b = i.issue({}, 1_800_000_000).token;
  assert.notEqual(a, b);
  const pub = publicKey;
  assert.equal(verifyEs256(a, pub), true);
  assert.equal(verifyEs256(b, pub), true);
});

test('mapkit: rejects malformed team and key ids at construction', () => {
  assert.throws(() => new MapKitTokenIssuer({ teamId: 'short', keyId: KEY, privateKeyPem: PEM }));
  assert.throws(() => new MapKitTokenIssuer({ teamId: TEAM, keyId: 'lowercase1', privateKeyPem: PEM }));
});

test('mapkit: rejects a non-EC key', () => {
  const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const rsaPem = rsa.privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;
  assert.throws(() => new MapKitTokenIssuer({ teamId: TEAM, keyId: KEY, privateKeyPem: rsaPem }));
});

test('mapkit: rejects an absurd TTL', () => {
  const i = issuer();
  assert.throws(() => i.issue({ ttlSeconds: 0 }));
  assert.throws(() => i.issue({ ttlSeconds: MAX_TTL_SECONDS + 1 }));
  assert.throws(() => i.issue({ ttlSeconds: -1 }));
});

test('mapkit: DER conversion always yields 64 bytes, padding short integers', () => {
  // r is 1 byte, s is 32 bytes: the short one must be left-padded to 32.
  const der = Buffer.concat([
    Buffer.from([0x30, 0x26]),
    Buffer.from([0x02, 0x01, 0x05]),
    Buffer.from([0x02, 0x21, 0x00]), Buffer.alloc(32, 0xab),
  ]);
  const jose = derToJoseP256(der);
  assert.equal(jose.length, 64);
  assert.equal(jose[31], 0x05);          // r right-aligned
  assert.equal(jose.subarray(0, 31).every((b) => b === 0), true);
  assert.equal(jose[32], 0xab);          // s starts immediately after
});

test('mapkit: rejects a corrupt DER signature', () => {
  assert.throws(() => derToJoseP256(Buffer.from([0x00, 0x01])));
  assert.throws(() => derToJoseP256(Buffer.alloc(16)));
});
