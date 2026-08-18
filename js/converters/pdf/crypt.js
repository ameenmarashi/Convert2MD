/**
 * Standard security handler for PDFs that open without a password.
 *
 * Covers revisions 2–5: RC4 (40/128-bit), AES-128 (/AESV2) and AES-256 (/AESV3
 * revision 5). Revision 6 needs the hardened SHA-384/512 hash and is reported
 * as unsupported rather than silently producing garbage.
 */
import { PdfName, PdfString } from './lexer.js';
const PAD = Uint8Array.from([
    0x28, 0xbf, 0x4e, 0x5e, 0x4e, 0x75, 0x8a, 0x41, 0x64, 0x00, 0x4e, 0x56, 0xff, 0xfa, 0x01, 0x08,
    0x2e, 0x2e, 0x00, 0xb6, 0xd0, 0x68, 0x3e, 0x80, 0x2f, 0x0c, 0xa9, 0xfe, 0x64, 0x53, 0x69, 0x7a,
]);
export class DecryptionError extends Error {
}
export class Decryptor {
    constructor(key, method, revision) {
        this.key = key;
        this.method = method;
        this.revision = revision;
    }
    static create(encrypt, firstId, resolve) {
        const filter = nameOf(resolve(encrypt.get('Filter') ?? null));
        if (filter && filter !== 'Standard') {
            throw new DecryptionError(`Unsupported PDF security handler: ${filter}.`);
        }
        const v = numberOf(resolve(encrypt.get('V') ?? null), 0);
        const r = numberOf(resolve(encrypt.get('R') ?? null), 2);
        const length = numberOf(resolve(encrypt.get('Length') ?? null), 40);
        const p = numberOf(resolve(encrypt.get('P') ?? null), -1);
        const o = stringBytes(resolve(encrypt.get('O') ?? null));
        const u = stringBytes(resolve(encrypt.get('U') ?? null));
        const encryptMetadata = resolve(encrypt.get('EncryptMetadata') ?? null) !== false;
        let method = 'rc4';
        let keyLengthBytes = Math.max(5, Math.floor(length / 8));
        if (v >= 4) {
            const cfName = nameOf(resolve(encrypt.get('StmF') ?? null)) ?? 'Identity';
            const cf = resolve(encrypt.get('CF') ?? null);
            if (cfName === 'Identity') {
                method = 'identity';
            }
            else if (cf instanceof Map) {
                const entry = resolve(cf.get(cfName) ?? null);
                const cfm = entry instanceof Map ? nameOf(resolve(entry.get('CFM') ?? null)) : null;
                const cfLength = entry instanceof Map ? numberOf(resolve(entry.get('Length') ?? null), 0) : 0;
                if (cfm === 'AESV2') {
                    method = 'aes';
                    keyLengthBytes = 16;
                }
                else if (cfm === 'AESV3') {
                    method = 'aes';
                    keyLengthBytes = 32;
                }
                else if (cfm === 'None') {
                    method = 'identity';
                }
                else {
                    method = 'rc4';
                    if (cfLength > 0)
                        keyLengthBytes = cfLength > 40 ? Math.floor(cfLength / 8) : cfLength;
                }
            }
        }
        if (r >= 5) {
            if (r === 6) {
                throw new DecryptionError('This PDF uses AES-256 revision 6 encryption, which this converter cannot open.');
            }
            const key = deriveR5Key(u, resolve(encrypt.get('UE') ?? null));
            return new Decryptor(key, 'aes', r);
        }
        const key = deriveLegacyKey(o, p, firstId, r, keyLengthBytes, encryptMetadata);
        return new Decryptor(key, method, r);
    }
    decrypt(data, num, gen) {
        if (this.method === 'identity')
            return data;
        if (this.revision >= 5)
            return aesCbcDecrypt(this.key, data);
        const extra = this.method === 'aes' ? [0x73, 0x41, 0x6c, 0x54] : [];
        const input = new Uint8Array(this.key.length + 5 + extra.length);
        input.set(this.key, 0);
        input[this.key.length] = num & 0xff;
        input[this.key.length + 1] = (num >> 8) & 0xff;
        input[this.key.length + 2] = (num >> 16) & 0xff;
        input[this.key.length + 3] = gen & 0xff;
        input[this.key.length + 4] = (gen >> 8) & 0xff;
        input.set(extra, this.key.length + 5);
        const digest = md5(input);
        const objectKey = digest.subarray(0, Math.min(this.key.length + 5, 16));
        return this.method === 'aes' ? aesCbcDecrypt(objectKey, data) : rc4(objectKey, data);
    }
}
function deriveLegacyKey(o, p, firstId, revision, keyLength, encryptMetadata) {
    const parts = [];
    parts.push(...PAD); // empty user password padded
    parts.push(...o.subarray(0, 32));
    parts.push(p & 0xff, (p >> 8) & 0xff, (p >> 16) & 0xff, (p >> 24) & 0xff);
    parts.push(...firstId);
    if (revision >= 4 && !encryptMetadata)
        parts.push(0xff, 0xff, 0xff, 0xff);
    let digest = md5(Uint8Array.from(parts));
    if (revision >= 3) {
        for (let i = 0; i < 50; i++)
            digest = md5(digest.subarray(0, keyLength));
    }
    return digest.subarray(0, revision === 2 ? 5 : keyLength);
}
function deriveR5Key(u, ue) {
    if (u.length < 48)
        throw new DecryptionError('Encrypted PDF is missing its /U entry.');
    const keySalt = u.subarray(40, 48);
    const intermediate = sha256(concat(new Uint8Array(0), keySalt));
    const ueBytes = stringBytes(ue);
    if (ueBytes.length < 32)
        throw new DecryptionError('Encrypted PDF is missing its /UE entry.');
    return aesCbcNoPadDecrypt(intermediate, new Uint8Array(16), ueBytes.subarray(0, 32));
}
function concat(a, b) {
    const out = new Uint8Array(a.length + b.length);
    out.set(a, 0);
    out.set(b, a.length);
    return out;
}
function nameOf(value) {
    return value instanceof PdfName ? value.name : null;
}
function numberOf(value, fallback) {
    return typeof value === 'number' ? value : fallback;
}
function stringBytes(value) {
    return value instanceof PdfString ? value.bytes : new Uint8Array(0);
}
/* ------------------------------------------------------------------- RC4 */
export function rc4(key, data) {
    const s = new Uint8Array(256);
    for (let i = 0; i < 256; i++)
        s[i] = i;
    let j = 0;
    for (let i = 0; i < 256; i++) {
        j = (j + s[i] + key[i % key.length]) & 0xff;
        const tmp = s[i];
        s[i] = s[j];
        s[j] = tmp;
    }
    const out = new Uint8Array(data.length);
    let a = 0;
    let b = 0;
    for (let k = 0; k < data.length; k++) {
        a = (a + 1) & 0xff;
        b = (b + s[a]) & 0xff;
        const tmp = s[a];
        s[a] = s[b];
        s[b] = tmp;
        out[k] = data[k] ^ s[(s[a] + s[b]) & 0xff];
    }
    return out;
}
/* ------------------------------------------------------------------- MD5 */
const MD5_S = [
    7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
    5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
    4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
    6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
];
const MD5_K = new Int32Array(64);
for (let i = 0; i < 64; i++)
    MD5_K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 0x100000000);
export function md5(input) {
    const padded = padMessage(input, true);
    let a0 = 0x67452301;
    let b0 = 0xefcdab89;
    let c0 = 0x98badcfe;
    let d0 = 0x10325476;
    const view = new DataView(padded.buffer, padded.byteOffset, padded.byteLength);
    for (let chunk = 0; chunk < padded.length; chunk += 64) {
        const m = new Int32Array(16);
        for (let i = 0; i < 16; i++)
            m[i] = view.getInt32(chunk + i * 4, true);
        let a = a0;
        let b = b0;
        let c = c0;
        let d = d0;
        for (let i = 0; i < 64; i++) {
            let f;
            let g;
            if (i < 16) {
                f = (b & c) | (~b & d);
                g = i;
            }
            else if (i < 32) {
                f = (d & b) | (~d & c);
                g = (5 * i + 1) % 16;
            }
            else if (i < 48) {
                f = b ^ c ^ d;
                g = (3 * i + 5) % 16;
            }
            else {
                f = c ^ (b | ~d);
                g = (7 * i) % 16;
            }
            const tmp = d;
            d = c;
            c = b;
            const sum = (a + f + MD5_K[i] + m[g]) | 0;
            b = (b + rotl(sum, MD5_S[i])) | 0;
            a = tmp;
        }
        a0 = (a0 + a) | 0;
        b0 = (b0 + b) | 0;
        c0 = (c0 + c) | 0;
        d0 = (d0 + d) | 0;
    }
    const out = new Uint8Array(16);
    const outView = new DataView(out.buffer);
    outView.setInt32(0, a0, true);
    outView.setInt32(4, b0, true);
    outView.setInt32(8, c0, true);
    outView.setInt32(12, d0, true);
    return out;
}
function rotl(value, shift) {
    return (value << shift) | (value >>> (32 - shift));
}
function padMessage(input, littleEndian) {
    const bitLength = input.length * 8;
    const total = Math.ceil((input.length + 9) / 64) * 64;
    const out = new Uint8Array(total);
    out.set(input, 0);
    out[input.length] = 0x80;
    const view = new DataView(out.buffer);
    if (littleEndian) {
        view.setUint32(total - 8, bitLength >>> 0, true);
        view.setUint32(total - 4, Math.floor(bitLength / 0x100000000), true);
    }
    else {
        view.setUint32(total - 8, Math.floor(bitLength / 0x100000000), false);
        view.setUint32(total - 4, bitLength >>> 0, false);
    }
    return out;
}
/* --------------------------------------------------------------- SHA-256 */
const SHA256_K = new Int32Array([
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);
export function sha256(input) {
    const padded = padMessage(input, false);
    const h = new Int32Array([
        0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
    ]);
    const w = new Int32Array(64);
    const view = new DataView(padded.buffer, padded.byteOffset, padded.byteLength);
    for (let chunk = 0; chunk < padded.length; chunk += 64) {
        for (let i = 0; i < 16; i++)
            w[i] = view.getInt32(chunk + i * 4, false);
        for (let i = 16; i < 64; i++) {
            const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
            const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
            w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0;
        }
        let [a, b, c, d, e, f, g, hh] = h;
        for (let i = 0; i < 64; i++) {
            const s1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
            const ch = (e & f) ^ (~e & g);
            const temp1 = (hh + s1 + ch + SHA256_K[i] + w[i]) | 0;
            const s0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
            const maj = (a & b) ^ (a & c) ^ (b & c);
            const temp2 = (s0 + maj) | 0;
            hh = g;
            g = f;
            f = e;
            e = (d + temp1) | 0;
            d = c;
            c = b;
            b = a;
            a = (temp1 + temp2) | 0;
        }
        h[0] = (h[0] + a) | 0;
        h[1] = (h[1] + b) | 0;
        h[2] = (h[2] + c) | 0;
        h[3] = (h[3] + d) | 0;
        h[4] = (h[4] + e) | 0;
        h[5] = (h[5] + f) | 0;
        h[6] = (h[6] + g) | 0;
        h[7] = (h[7] + hh) | 0;
    }
    const out = new Uint8Array(32);
    const outView = new DataView(out.buffer);
    for (let i = 0; i < 8; i++)
        outView.setInt32(i * 4, h[i], false);
    return out;
}
function rotr(value, shift) {
    return (value >>> shift) | (value << (32 - shift));
}
/* ------------------------------------------------------------------- AES */
const SBOX = new Uint8Array(256);
const INV_SBOX = new Uint8Array(256);
(() => {
    // Build via the standard affine transform over the multiplicative inverse.
    const inverse = new Uint8Array(256);
    for (let i = 0; i < 256; i++) {
        for (let j = 0; j < 256; j++) {
            if (gmul(i, j) === 1) {
                inverse[i] = j;
                break;
            }
        }
    }
    for (let i = 0; i < 256; i++) {
        const b = inverse[i];
        let value = b ^ rotl8(b, 1) ^ rotl8(b, 2) ^ rotl8(b, 3) ^ rotl8(b, 4) ^ 0x63;
        value &= 0xff;
        SBOX[i] = value;
        INV_SBOX[value] = i;
    }
})();
function rotl8(value, shift) {
    return ((value << shift) | (value >>> (8 - shift))) & 0xff;
}
function gmul(a, b) {
    let result = 0;
    let x = a;
    let y = b;
    for (let i = 0; i < 8; i++) {
        if (y & 1)
            result ^= x;
        const high = x & 0x80;
        x = (x << 1) & 0xff;
        if (high)
            x ^= 0x1b;
        y >>= 1;
    }
    return result;
}
function expandKey(key) {
    const nk = key.length / 4;
    const nr = nk + 6;
    const w = [];
    for (let i = 0; i < nk; i++)
        w.push([key[4 * i], key[4 * i + 1], key[4 * i + 2], key[4 * i + 3]]);
    let rcon = 1;
    for (let i = nk; i < 4 * (nr + 1); i++) {
        let temp = w[i - 1].slice();
        if (i % nk === 0) {
            temp = [SBOX[temp[1]] ^ rcon, SBOX[temp[2]], SBOX[temp[3]], SBOX[temp[0]]];
            rcon = gmul(rcon, 2);
        }
        else if (nk > 6 && i % nk === 4) {
            temp = temp.map((byte) => SBOX[byte]);
        }
        w.push(w[i - nk].map((byte, j) => byte ^ temp[j]));
    }
    const roundKeys = [];
    for (let round = 0; round <= nr; round++) {
        const rk = new Uint8Array(16);
        for (let col = 0; col < 4; col++)
            rk.set(w[round * 4 + col], col * 4);
        roundKeys.push(rk);
    }
    return roundKeys;
}
function decryptBlock(roundKeys, block) {
    const state = block.slice();
    const rounds = roundKeys.length - 1;
    addRoundKey(state, roundKeys[rounds]);
    for (let round = rounds - 1; round >= 1; round--) {
        invShiftRows(state);
        invSubBytes(state);
        addRoundKey(state, roundKeys[round]);
        invMixColumns(state);
    }
    invShiftRows(state);
    invSubBytes(state);
    addRoundKey(state, roundKeys[0]);
    return state;
}
function addRoundKey(state, key) {
    for (let i = 0; i < 16; i++)
        state[i] ^= key[i];
}
function invSubBytes(state) {
    for (let i = 0; i < 16; i++)
        state[i] = INV_SBOX[state[i]];
}
function invShiftRows(state) {
    const copy = state.slice();
    for (let row = 1; row < 4; row++) {
        for (let col = 0; col < 4; col++) {
            state[col * 4 + row] = copy[((col - row + 4) % 4) * 4 + row];
        }
    }
}
function invMixColumns(state) {
    for (let col = 0; col < 4; col++) {
        const i = col * 4;
        const a0 = state[i];
        const a1 = state[i + 1];
        const a2 = state[i + 2];
        const a3 = state[i + 3];
        state[i] = gmul(a0, 14) ^ gmul(a1, 11) ^ gmul(a2, 13) ^ gmul(a3, 9);
        state[i + 1] = gmul(a0, 9) ^ gmul(a1, 14) ^ gmul(a2, 11) ^ gmul(a3, 13);
        state[i + 2] = gmul(a0, 13) ^ gmul(a1, 9) ^ gmul(a2, 14) ^ gmul(a3, 11);
        state[i + 3] = gmul(a0, 11) ^ gmul(a1, 13) ^ gmul(a2, 9) ^ gmul(a3, 14);
    }
}
/** AES-CBC where the first 16 bytes of `data` are the IV (PDF convention). */
export function aesCbcDecrypt(key, data) {
    if (data.length <= 16)
        return new Uint8Array(0);
    const iv = data.subarray(0, 16);
    const body = data.subarray(16);
    const out = aesCbcNoPadDecrypt(key, iv, body);
    const padding = out[out.length - 1];
    return padding >= 1 && padding <= 16 ? out.subarray(0, out.length - padding) : out;
}
export function aesCbcNoPadDecrypt(key, iv, data) {
    const roundKeys = expandKey(key);
    const blocks = Math.floor(data.length / 16);
    const out = new Uint8Array(blocks * 16);
    let previous = iv;
    for (let i = 0; i < blocks; i++) {
        const block = data.subarray(i * 16, i * 16 + 16);
        const plain = decryptBlock(roundKeys, block);
        for (let j = 0; j < 16; j++)
            plain[j] ^= previous[j];
        out.set(plain, i * 16);
        previous = block;
    }
    return out;
}
//# sourceMappingURL=crypt.js.map