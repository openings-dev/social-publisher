import { createCipheriv, createDecipheriv, createPublicKey, privateDecrypt, publicEncrypt, randomBytes, constants } from 'node:crypto';

export function sealCredential({ publicKey, value, transferId }) {
  const key = createPublicKey(publicKey);
  if (key.asymmetricKeyType !== 'rsa' || key.asymmetricKeyDetails.modulusLength < 3072) throw new Error('RSA key must be at least 3072 bits');
  if (typeof value !== 'string' || !value.trim() || typeof transferId !== 'string' || !/^[a-z0-9-]{1,80}$/.test(transferId)) throw new Error('Invalid credential transfer');
  const sessionKey = randomBytes(32);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', sessionKey, iv);
  cipher.setAAD(Buffer.from(transferId));
  const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return {
    version: 1, transferId, iv: iv.toString('base64'), ciphertext: ciphertext.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    wrappedKey: publicEncrypt({ key, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' }, sessionKey).toString('base64'),
  };
}

export function unsealCredential({ privateKey, sealed, transferId }) {
  if (sealed.version !== 1 || sealed.transferId !== transferId) throw new Error('Wrong credential transfer');
  const key = privateDecrypt({ key: privateKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' }, Buffer.from(sealed.wrappedKey, 'base64'));
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(sealed.iv, 'base64'));
  decipher.setAAD(Buffer.from(transferId));
  decipher.setAuthTag(Buffer.from(sealed.tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(sealed.ciphertext, 'base64')), decipher.final()]).toString('utf8');
}
