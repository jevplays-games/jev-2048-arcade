import {canonical, applySpawn, spawnFor} from './rules.js';
export const RNG_VERSION = 'paired-spawn-v1';
const encoder = new TextEncoder();
const HEX = Array.from({length: 256}, (_, i) => i.toString(16).padStart(2, '0'));
export const hexReference = bytes => Array.from(bytes, x => x.toString(16).padStart(2, '0')).join('');
export function hex(bytes) {
  let out = '';
  for (let i = 0; i < bytes.length; i++) out += HEX[bytes[i]];
  return out;
}
export function unhex(s) {
  if (typeof s !== 'string' || !/^(?:[a-f0-9]{2})+$/i.test(s)) throw new Error('Invalid hex.');
  return Uint8Array.from(s.match(/../g), x => parseInt(x, 16));
}
export const randomHex = (n = 32) => hex(crypto.getRandomValues(new Uint8Array(n)));
export async function sha256(value) {
  const input = typeof value === 'string' ? value : canonical(value);
  return hex(new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(input))));
}
export async function hmac(key, message) {
  const k = await crypto.subtle.importKey('raw', unhex(key), {name: 'HMAC', hash: 'SHA-256'}, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', k, encoder.encode(message)));
}
export async function deriveSpawn(seed, index, stage = 'move') {
  if (!Number.isSafeInteger(index) || index < 0 || !['init', 'move'].includes(stage)) throw new Error('Invalid spawn index.');
  let buffer = new Uint8Array(0), offset = 0, block = 0;
  async function bounded(n) {
    const limit = Math.floor(65536 / n) * n;
    while (true) {
      if (offset + 1 >= buffer.length) {
        buffer = await hmac(seed, `spawn:v1:${stage}:${index}:positions:${block++}`); offset = 0;
      }
      const x = buffer[offset++] * 256 + buffer[offset++];
      if (x < limit) return x % n;
    }
  }
  // A separate unbiased stream prevents position draws from changing the tile value.
  let vb = 0, value;
  while (value === undefined) {
    for (const b of await hmac(seed, `spawn:v1:${stage}:${index}:value:${vb++}`)) {
      if (b < 250) { value = b % 10; break; }
    }
  }
  const order = Array.from({length: 16}, (_, i) => i);
  for (let i = 15; i > 0; i--) { const j = await bounded(i + 1); [order[i], order[j]] = [order[j], order[i]]; }
  return {exponent: value === 9 ? 2 : 1, order};
}
export async function initialCells(seed) {
  let cells = Array(16).fill(0);
  for (let i = 0; i < 2; i++) cells = applySpawn(cells, spawnFor(cells, await deriveSpawn(seed, i, 'init')));
  return cells;
}
export const seedCommitment = (manifest, seed) => sha256({manifest, seed});
export async function encrypt(keyHex, text) {
  const key = await crypto.subtle.importKey('raw', unhex(keyHex), 'AES-GCM', false, ['encrypt']);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cipher = new Uint8Array(await crypto.subtle.encrypt({name: 'AES-GCM', iv}, key, encoder.encode(text)));
  return hex(iv) + '.' + hex(cipher);
}
export async function decrypt(keyHex, text) {
  const [iv, cipher] = text.split('.');
  const key = await crypto.subtle.importKey('raw', unhex(keyHex), 'AES-GCM', false, ['decrypt']);
  return new TextDecoder().decode(await crypto.subtle.decrypt({name: 'AES-GCM', iv: unhex(iv)}, key, unhex(cipher)));
}
export const b64url = text => btoa(String.fromCharCode(...encoder.encode(text))).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
export function unb64url(text) {
  const t = text.replaceAll('-', '+').replaceAll('_', '/');
  return new TextDecoder().decode(Uint8Array.from(atob(t), x => x.charCodeAt(0)));
}
export async function signToken(secret, payload) {
  const body = b64url(canonical(payload)); return body + '.' + hex(await hmac(secret, body));
}
export async function verifyToken(secret, token) {
  if (typeof token !== 'string' || token.length > 4096) throw new Error('Invalid token.');
  const parts = token.split('.'); if (parts.length !== 2) throw new Error('Invalid token.');
  const key = await crypto.subtle.importKey('raw', unhex(secret), {name: 'HMAC', hash: 'SHA-256'}, false, ['verify']);
  const ok = await crypto.subtle.verify('HMAC', key, unhex(parts[1]), encoder.encode(parts[0]));
  if (!ok) throw new Error('Invalid signature.');
  const payload = JSON.parse(unb64url(parts[0]));
  if (!Number.isSafeInteger(payload.exp) || payload.exp <= Date.now()) throw new Error('Token expired.');
  return payload;
}
