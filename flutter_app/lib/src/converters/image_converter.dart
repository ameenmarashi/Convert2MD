import 'dart:typed_data';

import '../core/conversion.dart';
import '../core/markdown.dart';
import '../core/text_decode.dart';

/// Images → Markdown. The picture is embedded so the note stays self-contained.
/// Mirrors `web/src/converters/image.ts`.
RawOutput convertImage(SourceFile file, ConvertOptions options) {
  final writer = MarkdownWriter();
  final warnings = <String>[];
  final meta = <String, String>{'size': formatBytes(file.bytes.length)};
  final alt = file.name.replaceFirst(RegExp(r'\.[^.]+$'), '');
  final dimensions = readDimensions(file);
  if (dimensions != null) meta['dimensions'] = '${dimensions.width}×${dimensions.height}';

  var imageCount = 0;

  if (options.imageMode == ImageMode.skip) {
    writer.paragraph('_Image omitted: ${alt}_');
  } else if (options.imageMode == ImageMode.reference ||
      file.bytes.length > options.maxEmbeddedImageBytes) {
    if (file.bytes.length > options.maxEmbeddedImageBytes &&
        options.imageMode == ImageMode.embed) {
      warnings.add(
          'The image is ${formatBytes(file.bytes.length)}, above the inline limit, so it is linked by file name instead.');
    }
    writer.push(mdImage(alt, file.name));
    imageCount++;
  } else {
    writer.push(mdImage(alt, dataUri(file.bytes, imageMimeFor(file.name))));
    imageCount++;
  }

  return RawOutput(
    markdown: writer.toString(),
    meta: meta,
    warnings: warnings,
    imageCount: imageCount,
  );
}

class ImageDimensions {
  const ImageDimensions(this.width, this.height);

  final int width;
  final int height;
}

/// Read intrinsic size from the container header — no decoding required.
ImageDimensions? readDimensions(SourceFile file) {
  final bytes = file.bytes;
  final view = ByteData.view(bytes.buffer, bytes.offsetInBytes, bytes.lengthInBytes);

  if (bytes.length > 24 && bytes[0] == 0x89 && bytes[1] == 0x50) {
    return ImageDimensions(view.getUint32(16), view.getUint32(20));
  }

  if (bytes.length > 10 && bytes[0] == 0xff && bytes[1] == 0xd8) {
    var offset = 2;
    while (offset + 9 < bytes.length) {
      if (bytes[offset] != 0xff) {
        offset++;
        continue;
      }
      final marker = bytes[offset + 1];
      final length = view.getUint16(offset + 2);
      if (marker >= 0xc0 && marker <= 0xcf && marker != 0xc4 && marker != 0xc8 && marker != 0xcc) {
        return ImageDimensions(view.getUint16(offset + 7), view.getUint16(offset + 5));
      }
      offset += 2 + length;
    }
    return null;
  }

  if (bytes.length > 10 && bytes[0] == 0x47 && bytes[1] == 0x49 && bytes[2] == 0x46) {
    return ImageDimensions(view.getUint16(6, Endian.little), view.getUint16(8, Endian.little));
  }

  if (bytes.length > 26 && bytes[0] == 0x42 && bytes[1] == 0x4d) {
    return ImageDimensions(
      view.getInt32(18, Endian.little),
      view.getInt32(22, Endian.little).abs(),
    );
  }

  if (file.name.toLowerCase().endsWith('.svg')) {
    final head = decodeText(bytes.sublist(0, bytes.length < 2048 ? bytes.length : 2048)).text;
    final width = RegExp(r'\bwidth\s*=\s*"(\d+(?:\.\d+)?)').firstMatch(head);
    final height = RegExp(r'\bheight\s*=\s*"(\d+(?:\.\d+)?)').firstMatch(head);
    if (width != null && height != null) {
      return ImageDimensions(
        double.parse(width.group(1)!).round(),
        double.parse(height.group(1)!).round(),
      );
    }
  }

  return null;
}
