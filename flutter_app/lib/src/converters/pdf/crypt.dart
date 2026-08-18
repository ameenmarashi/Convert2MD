import 'dart:typed_data';

import 'package:crypto/crypto.dart' as crypto;

import 'lexer.dart';

/// Standard security handler for PDFs that open without a password.
/// Covers revisions 2–5 (RC4, AES-128 /AESV2, AES-256 revision 5).
/// Mirrors `web/src/converters/pdf/crypt.ts`.
class DecryptionException implements Exception {
  const DecryptionException(this.message);

  final String message;

  @override
  String toString() => message;
}

enum CryptMethod { rc4, aes, identity }

final Uint8List _pad = Uint8List.fromList(const [
  0x28, 0xbf, 0x4e, 0x5e, 0x4e, 0x75, 0x8a, 0x41, 0x64, 0x00, 0x4e, 0x56, 0xff, 0xfa, 0x01, 0x08,
  0x2e, 0x2e, 0x00, 0xb6, 0xd0, 0x68, 0x3e, 0x80, 0x2f, 0x0c, 0xa9, 0xfe, 0x64, 0x53, 0x69, 0x7a,
]);

class Decryptor {
  Decryptor._(this._key, this._method, this._revision);

  final Uint8List _key;
  final CryptMethod _method;
  final int _revision;

  static Decryptor create(PdfDict encrypt, Uint8List firstId, Object? Function(Object?) resolve) {
    final filter = _nameOf(resolve(encrypt['Filter']));
    if (filter != null && filter != 'Standard') {
      throw DecryptionException('Unsupported PDF security handler: $filter.');
    }

    final v = _numberOf(resolve(encrypt['V']), 0).toInt();
    final r = _numberOf(resolve(encrypt['R']), 2).toInt();
    final length = _numberOf(resolve(encrypt['Length']), 40).toInt();
    final p = _numberOf(resolve(encrypt['P']), -1).toInt();
    final o = _stringBytes(resolve(encrypt['O']));
    final encryptMetadata = resolve(encrypt['EncryptMetadata']) != false;

    var method = CryptMethod.rc4;
    var keyLengthBytes = (length ~/ 8) < 5 ? 5 : length ~/ 8;

    if (v >= 4) {
      final cfName = _nameOf(resolve(encrypt['StmF'])) ?? 'Identity';
      final cf = resolve(encrypt['CF']);
      if (cfName == 'Identity') {
        method = CryptMethod.identity;
      } else if (cf is Map) {
        final entry = resolve(cf[cfName]);
        final cfm = entry is Map ? _nameOf(resolve(entry['CFM'])) : null;
        final cfLength = entry is Map ? _numberOf(resolve(entry['Length']), 0).toInt() : 0;
        if (cfm == 'AESV2') {
          method = CryptMethod.aes;
          keyLengthBytes = 16;
        } else if (cfm == 'AESV3') {
          method = CryptMethod.aes;
          keyLengthBytes = 32;
        } else if (cfm == 'None') {
          method = CryptMethod.identity;
        } else {
          method = CryptMethod.rc4;
          if (cfLength > 0) keyLengthBytes = cfLength > 40 ? cfLength ~/ 8 : cfLength;
        }
      }
    }

    if (r >= 5) {
      if (r == 6) {
        throw const DecryptionException(
          'This PDF uses AES-256 revision 6 encryption, which this converter cannot open.',
        );
      }
      final u = _stringBytes(resolve(encrypt['U']));
      return Decryptor._(_deriveR5Key(u, resolve(encrypt['UE'])), CryptMethod.aes, r);
    }

    final key = _deriveLegacyKey(o, p, firstId, r, keyLengthBytes, encryptMetadata);
    return Decryptor._(key, method, r);
  }

  Uint8List decrypt(Uint8List data, int num, int gen) {
    if (_method == CryptMethod.identity) return data;
    if (_revision >= 5) return aesCbcDecrypt(_key, data);

    final extra = _method == CryptMethod.aes ? const [0x73, 0x41, 0x6c, 0x54] : const <int>[];
    final input = Uint8List(_key.length + 5 + extra.length);
    input.setRange(0, _key.length, _key);
    input[_key.length] = num & 0xff;
    input[_key.length + 1] = (num >> 8) & 0xff;
    input[_key.length + 2] = (num >> 16) & 0xff;
    input[_key.length + 3] = gen & 0xff;
    input[_key.length + 4] = (gen >> 8) & 0xff;
    input.setRange(_key.length + 5, input.length, extra);

    final digest = _md5(input);
    final size = _key.length + 5 > 16 ? 16 : _key.length + 5;
    final objectKey = Uint8List.sublistView(digest, 0, size);
    return _method == CryptMethod.aes ? aesCbcDecrypt(objectKey, data) : rc4(objectKey, data);
  }
}

Uint8List _deriveLegacyKey(
  Uint8List o,
  int p,
  Uint8List firstId,
  int revision,
  int keyLength,
  bool encryptMetadata,
) {
  final parts = <int>[
    ..._pad,
    ...o.take(32),
    p & 0xff,
    (p >> 8) & 0xff,
    (p >> 16) & 0xff,
    (p >> 24) & 0xff,
    ...firstId,
    if (revision >= 4 && !encryptMetadata) ...[0xff, 0xff, 0xff, 0xff],
  ];

  var digest = _md5(Uint8List.fromList(parts));
  if (revision >= 3) {
    for (var i = 0; i < 50; i++) {
      digest = _md5(Uint8List.sublistView(digest, 0, keyLength));
    }
  }
  final size = revision == 2 ? 5 : keyLength;
  return Uint8List.sublistView(digest, 0, size > digest.length ? digest.length : size);
}

Uint8List _deriveR5Key(Uint8List u, Object? ue) {
  if (u.length < 48) {
    throw const DecryptionException('Encrypted PDF is missing its /U entry.');
  }
  final keySalt = Uint8List.sublistView(u, 40, 48);
  final intermediate = _sha256(keySalt);
  final ueBytes = _stringBytes(ue);
  if (ueBytes.length < 32) {
    throw const DecryptionException('Encrypted PDF is missing its /UE entry.');
  }
  return aesCbcNoPadDecrypt(intermediate, Uint8List(16), Uint8List.sublistView(ueBytes, 0, 32));
}

Uint8List _md5(Uint8List input) => Uint8List.fromList(crypto.md5.convert(input).bytes);

Uint8List _sha256(Uint8List input) => Uint8List.fromList(crypto.sha256.convert(input).bytes);

String? _nameOf(Object? value) => value is PdfName ? value.name : null;

double _numberOf(Object? value, double fallback) => value is num ? value.toDouble() : fallback;

Uint8List _stringBytes(Object? value) => value is PdfString ? value.bytes : Uint8List(0);

/* ------------------------------------------------------------------- RC4 */

Uint8List rc4(Uint8List key, Uint8List data) {
  final s = Uint8List(256);
  for (var i = 0; i < 256; i++) {
    s[i] = i;
  }

  var j = 0;
  for (var i = 0; i < 256; i++) {
    j = (j + s[i] + key[i % key.length]) & 0xff;
    final tmp = s[i];
    s[i] = s[j];
    s[j] = tmp;
  }

  final out = Uint8List(data.length);
  var a = 0;
  var b = 0;
  for (var k = 0; k < data.length; k++) {
    a = (a + 1) & 0xff;
    b = (b + s[a]) & 0xff;
    final tmp = s[a];
    s[a] = s[b];
    s[b] = tmp;
    out[k] = data[k] ^ s[(s[a] + s[b]) & 0xff];
  }
  return out;
}

/* ------------------------------------------------------------------- AES */

final Uint8List _sbox = Uint8List(256);
final Uint8List _invSbox = Uint8List(256);
var _tablesReady = false;

void _buildTables() {
  if (_tablesReady) return;
  final inverse = Uint8List(256);
  for (var i = 0; i < 256; i++) {
    for (var j = 0; j < 256; j++) {
      if (_gmul(i, j) == 1) {
        inverse[i] = j;
        break;
      }
    }
  }
  for (var i = 0; i < 256; i++) {
    final b = inverse[i];
    final value = (b ^ _rotl8(b, 1) ^ _rotl8(b, 2) ^ _rotl8(b, 3) ^ _rotl8(b, 4) ^ 0x63) & 0xff;
    _sbox[i] = value;
    _invSbox[value] = i;
  }
  _tablesReady = true;
}

int _rotl8(int value, int shift) => ((value << shift) | (value >> (8 - shift))) & 0xff;

int _gmul(int a, int b) {
  var result = 0;
  var x = a;
  var y = b;
  for (var i = 0; i < 8; i++) {
    if (y & 1 != 0) result ^= x;
    final high = x & 0x80;
    x = (x << 1) & 0xff;
    if (high != 0) x ^= 0x1b;
    y >>= 1;
  }
  return result;
}

List<Uint8List> _expandKey(Uint8List key) {
  _buildTables();
  final nk = key.length ~/ 4;
  final nr = nk + 6;
  final w = <List<int>>[];

  for (var i = 0; i < nk; i++) {
    w.add([key[4 * i], key[4 * i + 1], key[4 * i + 2], key[4 * i + 3]]);
  }

  var rcon = 1;
  for (var i = nk; i < 4 * (nr + 1); i++) {
    var temp = List<int>.from(w[i - 1]);
    if (i % nk == 0) {
      temp = [_sbox[temp[1]] ^ rcon, _sbox[temp[2]], _sbox[temp[3]], _sbox[temp[0]]];
      rcon = _gmul(rcon, 2);
    } else if (nk > 6 && i % nk == 4) {
      temp = temp.map((byte) => _sbox[byte]).toList();
    }
    w.add(List<int>.generate(4, (j) => w[i - nk][j] ^ temp[j]));
  }

  final roundKeys = <Uint8List>[];
  for (var round = 0; round <= nr; round++) {
    final rk = Uint8List(16);
    for (var col = 0; col < 4; col++) {
      rk.setRange(col * 4, col * 4 + 4, w[round * 4 + col]);
    }
    roundKeys.add(rk);
  }
  return roundKeys;
}

Uint8List _decryptBlock(List<Uint8List> roundKeys, Uint8List block) {
  final state = Uint8List.fromList(block);
  final rounds = roundKeys.length - 1;

  _addRoundKey(state, roundKeys[rounds]);
  for (var round = rounds - 1; round >= 1; round--) {
    _invShiftRows(state);
    _invSubBytes(state);
    _addRoundKey(state, roundKeys[round]);
    _invMixColumns(state);
  }
  _invShiftRows(state);
  _invSubBytes(state);
  _addRoundKey(state, roundKeys[0]);
  return state;
}

void _addRoundKey(Uint8List state, Uint8List key) {
  for (var i = 0; i < 16; i++) {
    state[i] ^= key[i];
  }
}

void _invSubBytes(Uint8List state) {
  for (var i = 0; i < 16; i++) {
    state[i] = _invSbox[state[i]];
  }
}

void _invShiftRows(Uint8List state) {
  final copy = Uint8List.fromList(state);
  for (var row = 1; row < 4; row++) {
    for (var col = 0; col < 4; col++) {
      state[col * 4 + row] = copy[((col - row + 4) % 4) * 4 + row];
    }
  }
}

void _invMixColumns(Uint8List state) {
  for (var col = 0; col < 4; col++) {
    final i = col * 4;
    final a0 = state[i];
    final a1 = state[i + 1];
    final a2 = state[i + 2];
    final a3 = state[i + 3];
    state[i] = _gmul(a0, 14) ^ _gmul(a1, 11) ^ _gmul(a2, 13) ^ _gmul(a3, 9);
    state[i + 1] = _gmul(a0, 9) ^ _gmul(a1, 14) ^ _gmul(a2, 11) ^ _gmul(a3, 13);
    state[i + 2] = _gmul(a0, 13) ^ _gmul(a1, 9) ^ _gmul(a2, 14) ^ _gmul(a3, 11);
    state[i + 3] = _gmul(a0, 11) ^ _gmul(a1, 13) ^ _gmul(a2, 9) ^ _gmul(a3, 14);
  }
}

/// AES-CBC where the first 16 bytes of [data] are the IV (PDF convention).
Uint8List aesCbcDecrypt(Uint8List key, Uint8List data) {
  if (data.length <= 16) return Uint8List(0);
  final iv = Uint8List.sublistView(data, 0, 16);
  final body = Uint8List.sublistView(data, 16);
  final out = aesCbcNoPadDecrypt(key, iv, body);
  if (out.isEmpty) return out;
  final padding = out[out.length - 1];
  return padding >= 1 && padding <= 16 ? Uint8List.sublistView(out, 0, out.length - padding) : out;
}

Uint8List aesCbcNoPadDecrypt(Uint8List key, Uint8List iv, Uint8List data) {
  final roundKeys = _expandKey(key);
  final blocks = data.length ~/ 16;
  final out = Uint8List(blocks * 16);
  var previous = iv;

  for (var i = 0; i < blocks; i++) {
    final block = Uint8List.sublistView(data, i * 16, i * 16 + 16);
    final plain = _decryptBlock(roundKeys, block);
    for (var j = 0; j < 16; j++) {
      plain[j] ^= previous[j];
    }
    out.setRange(i * 16, i * 16 + 16, plain);
    previous = block;
  }
  return out;
}
