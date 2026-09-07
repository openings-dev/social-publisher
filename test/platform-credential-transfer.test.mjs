import { generateKeyPairSync } from 'node:crypto';
import assert from 'node:assert/strict';
import test from 'node:test';
import { sealCredential, unsealCredential } from '../src/modules/publishing/credential-transfer.mjs';
const keys = generateKeyPairSync('rsa', { modulusLength: 3072,
  publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});
test('only the local private key opens the authenticated credential transfer', () => {
  const value = 'test-only-secret'.repeat(100);
  const sealed = sealCredential({ publicKey: keys.publicKey, value, transferId: 'transfer-1' });
  assert.ok(!JSON.stringify(sealed).includes(value));
  assert.equal(unsealCredential({ privateKey: keys.privateKey, sealed, transferId: 'transfer-1' }), value);
  assert.throws(() => unsealCredential({ privateKey: keys.privateKey, sealed, transferId: 'transfer-2' }));
  assert.throws(() => unsealCredential({ privateKey: keys.privateKey, sealed: { ...sealed, tag: Buffer.alloc(16).toString('base64') }, transferId: 'transfer-1' }));
});
