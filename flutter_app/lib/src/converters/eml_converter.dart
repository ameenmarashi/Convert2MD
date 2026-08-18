import 'dart:convert';
import 'dart:typed_data';

import 'package:html/parser.dart' as html_parser;

import '../core/conversion.dart';
import '../core/markdown.dart';
import '../core/text_decode.dart';
import 'html_converter.dart';
import 'text_converter.dart';

/// Email (.eml / .mht) → Markdown. Mirrors `web/src/converters/eml.ts`.
RawOutput convertEml(SourceFile file, ConvertOptions options) {
  final warnings = <String>[];
  final root = _parsePart(file.bytes);

  final writer = MarkdownWriter();
  final meta = <String, String>{};

  final subject = decodeHeaderValue(root.headers['subject'] ?? '');
  final from = decodeHeaderValue(root.headers['from'] ?? '');
  final to = decodeHeaderValue(root.headers['to'] ?? '');
  final cc = decodeHeaderValue(root.headers['cc'] ?? '');
  final date = decodeHeaderValue(root.headers['date'] ?? '');

  final parts = _collectParts(root);

  var body = '';
  if (parts.html.isNotEmpty) {
    body = htmlToMarkdown(
      html_parser.parse(parts.html),
      HtmlOptions(
        bullet: options.bulletChar,
        resolveUrl: (url, kind) =>
            kind == UrlKind.image && url.startsWith('cid:') ? null : url,
      ),
    );
  } else if (parts.plain.isNotEmpty) {
    body = plainTextToMarkdown(parts.plain, options);
  } else {
    warnings.add('No readable body part was found in this message.');
  }

  if (subject.isNotEmpty) {
    meta['title'] = subject;
    // Newsletters usually repeat the subject as the body's first heading.
    final firstHeading = RegExp(r'^#{1,3}\s+(.+)$', multiLine: true).firstMatch(body);
    final duplicated =
        firstHeading != null && _normalizeHeading(firstHeading.group(1)!) == _normalizeHeading(subject);
    if (!duplicated) writer.heading(1, subject);
  }
  if (from.isNotEmpty) meta['author'] = from;
  if (date.isNotEmpty) meta['date'] = date;

  final summary = <List<String>>[
    ['Field', 'Value'],
    if (from.isNotEmpty) ['From', from],
    if (to.isNotEmpty) ['To', to],
    if (cc.isNotEmpty) ['Cc', cc],
    if (date.isNotEmpty) ['Date', date],
  ];
  if (summary.length > 1) writer.push(renderTable(summary));

  if (body.trim().isNotEmpty) writer.push(body);

  if (parts.attachments.isNotEmpty) {
    writer.heading(2, 'Attachments');
    writer.push(parts.attachments.map((name) => '- ${escapeBlock(name)}').join('\n'));
  }

  return RawOutput(markdown: writer.toString(), meta: meta, warnings: warnings);
}

String _normalizeHeading(String text) => text
    .replaceAll(RegExp(r'[*_`\\]'), '')
    .replaceAll(RegExp(r'\s+'), ' ')
    .trim()
    .toLowerCase();

class _MimePart {
  _MimePart({
    required this.headers,
    required this.body,
    required this.contentType,
    required this.charset,
    required this.disposition,
    required this.filename,
    required this.parts,
  });

  final Map<String, String> headers;
  final Uint8List body;
  final String contentType;
  final String charset;
  final String disposition;
  final String filename;
  final List<_MimePart> parts;
}

class _BodyParts {
  const _BodyParts(this.html, this.plain, this.attachments);

  final String html;
  final String plain;
  final List<String> attachments;
}

_BodyParts _collectParts(_MimePart part) {
  var html = '';
  var plain = '';
  final attachments = <String>[];

  void walk(_MimePart node) {
    if (node.parts.isNotEmpty) {
      for (final child in node.parts) {
        walk(child);
      }
      return;
    }

    final isAttachment = node.disposition == 'attachment' ||
        (node.filename.isNotEmpty && !node.contentType.startsWith('text/'));
    if (isAttachment) {
      if (node.filename.isNotEmpty) attachments.add(node.filename);
      return;
    }

    final text = decodeText(node.body, node.charset).text;
    if (node.contentType.startsWith('text/html')) {
      if (html.isEmpty) html = text;
    } else if (node.contentType.startsWith('text/') || node.contentType.isEmpty) {
      if (plain.isEmpty) plain = text;
    }
  }

  walk(part);
  return _BodyParts(html, plain, attachments);
}

_MimePart _parsePart(Uint8List bytes) {
  final split = _splitHeaders(bytes);
  final headers = _parseHeaders(split.headerText);

  final contentTypeRaw = headers['content-type'] ?? 'text/plain';
  final contentType = contentTypeRaw.split(';').first.trim().toLowerCase();
  final charset = _parameterOf(contentTypeRaw, 'charset');
  final boundary = _parameterOf(contentTypeRaw, 'boundary');
  final dispositionRaw = headers['content-disposition'] ?? '';
  final disposition = dispositionRaw.split(';').first.trim().toLowerCase();
  final filenameRaw = _parameterOf(dispositionRaw, 'filename').isNotEmpty
      ? _parameterOf(dispositionRaw, 'filename')
      : _parameterOf(contentTypeRaw, 'name');

  final encoding = (headers['content-transfer-encoding'] ?? '').trim().toLowerCase();
  var body = split.body;

  if (contentType.startsWith('multipart/') && boundary.isNotEmpty) {
    return _MimePart(
      headers: headers,
      body: Uint8List(0),
      contentType: contentType,
      charset: charset.isEmpty ? 'utf-8' : charset,
      disposition: disposition,
      filename: decodeHeaderValue(filenameRaw),
      parts: _splitMultipart(body, boundary).map(_parsePart).toList(),
    );
  }

  if (encoding == 'base64') {
    body = decodeBase64Bytes(body);
  } else if (encoding == 'quoted-printable') {
    body = decodeQuotedPrintable(body);
  }

  return _MimePart(
    headers: headers,
    body: body,
    contentType: contentType,
    charset: charset.isEmpty ? 'utf-8' : charset,
    disposition: disposition,
    filename: decodeHeaderValue(filenameRaw),
    parts: const [],
  );
}

class _HeaderSplit {
  const _HeaderSplit(this.headerText, this.body);

  final String headerText;
  final Uint8List body;
}

_HeaderSplit _splitHeaders(Uint8List bytes) {
  for (var i = 0; i + 1 < bytes.length; i++) {
    if (bytes[i] == 0x0a && bytes[i + 1] == 0x0a) {
      return _HeaderSplit(latin1String(bytes.sublist(0, i)), bytes.sublist(i + 2));
    }
    if (i + 3 < bytes.length &&
        bytes[i] == 0x0d &&
        bytes[i + 1] == 0x0a &&
        bytes[i + 2] == 0x0d &&
        bytes[i + 3] == 0x0a) {
      return _HeaderSplit(latin1String(bytes.sublist(0, i)), bytes.sublist(i + 4));
    }
  }
  return _HeaderSplit(latin1String(bytes), Uint8List(0));
}

Map<String, String> _parseHeaders(String text) {
  final headers = <String, String>{};
  final unfolded = text.replaceAll(RegExp(r'\r?\n[ \t]+'), ' ');
  for (final line in unfolded.split(RegExp(r'\r?\n'))) {
    final colon = line.indexOf(':');
    if (colon <= 0) continue;
    final key = line.substring(0, colon).trim().toLowerCase();
    headers.putIfAbsent(key, () => line.substring(colon + 1).trim());
  }
  return headers;
}

String _parameterOf(String header, String name) {
  final match = RegExp('$name\\s*=\\s*("([^"]*)"|[^;\\s]+)', caseSensitive: false).firstMatch(header);
  if (match == null) return '';
  return (match.group(2) ?? match.group(1) ?? '').trim();
}

List<Uint8List> _splitMultipart(Uint8List body, String boundary) {
  final text = latin1String(body);
  final marker = '--$boundary';
  final parts = <Uint8List>[];

  var index = text.indexOf(marker);
  if (index == -1) return parts;

  while (index != -1) {
    final start = text.indexOf('\n', index);
    if (start == -1) break;
    final nextIndex = text.indexOf(marker, start);
    final end = nextIndex == -1 ? text.length : nextIndex;

    var sliceEnd = end;
    if (sliceEnd > start && text[sliceEnd - 1] == '\n') sliceEnd--;
    if (sliceEnd > start && text[sliceEnd - 1] == '\r') sliceEnd--;

    parts.add(body.sublist(start + 1, sliceEnd));
    if (nextIndex == -1 || text.startsWith('$marker--', nextIndex)) break;
    index = nextIndex;
  }
  return parts;
}

/// RFC 2047 `=?utf-8?B?...?=` encoded words in header values.
String decodeHeaderValue(String value) {
  if (!value.contains('=?')) return value.trim();

  return value
      .replaceAllMapped(
        RegExp(r'=\?([^?]+)\?([BbQq])\?([^?]*)\?='),
        (match) {
          final charset = match.group(1)!;
          final kind = match.group(2)!.toLowerCase();
          final payload = match.group(3)!;
          try {
            final bytes = kind == 'b'
                ? decodeBase64Bytes(_latin1Bytes(payload))
                : decodeQuotedPrintable(_latin1Bytes(payload.replaceAll('_', ' ')));
            return decodeText(bytes, charset).text;
          } catch (_) {
            return payload;
          }
        },
      )
      .trim();
}

Uint8List _latin1Bytes(String text) {
  final out = Uint8List(text.length);
  for (var i = 0; i < text.length; i++) {
    out[i] = text.codeUnitAt(i) & 0xff;
  }
  return out;
}

Uint8List decodeBase64Bytes(Uint8List bytes) {
  final cleaned = StringBuffer();
  for (final byte in bytes) {
    final ch = String.fromCharCode(byte);
    if (RegExp('[A-Za-z0-9+/=]').hasMatch(ch)) cleaned.write(ch);
  }
  var text = cleaned.toString().replaceAll('=', '');
  final padding = text.length % 4;
  if (padding == 2) {
    text += '==';
  } else if (padding == 3) {
    text += '=';
  } else if (padding == 1) {
    text = text.substring(0, text.length - 1);
  }
  try {
    return base64Decode(text);
  } on FormatException {
    return Uint8List(0);
  }
}

Uint8List decodeQuotedPrintable(Uint8List bytes) {
  final out = <int>[];
  for (var i = 0; i < bytes.length; i++) {
    final byte = bytes[i];
    if (byte != 0x3d) {
      out.add(byte);
      continue;
    }
    final a = i + 1 < bytes.length ? bytes[i + 1] : 0;
    final b = i + 2 < bytes.length ? bytes[i + 2] : 0;
    if (a == 0x0a) {
      i += 1;
      continue;
    }
    if (a == 0x0d && b == 0x0a) {
      i += 2;
      continue;
    }
    final value = int.tryParse(String.fromCharCodes([a, b]), radix: 16);
    if (value != null) {
      out.add(value);
      i += 2;
    } else {
      out.add(byte);
    }
  }
  return Uint8List.fromList(out);
}
