import 'dart:typed_data';

/// Shared conversion contract. Mirrors `web/src/core/types.ts` so both apps
/// produce the same Markdown for the same input.
enum ImageMode { embed, reference, skip }

enum BulletStyle { hyphen, asterisk, plus }

extension BulletStyleChar on BulletStyle {
  String get char => switch (this) {
        BulletStyle.hyphen => '-',
        BulletStyle.asterisk => '*',
        BulletStyle.plus => '+',
      };
}

class ConvertOptions {
  const ConvertOptions({
    this.frontMatter = true,
    this.imageMode = ImageMode.embed,
    this.maxEmbeddedImageBytes = 512 * 1024,
    this.pageSeparators = true,
    this.includeNotes = true,
    this.bullet = BulletStyle.hyphen,
    this.detectPdfHeadings = true,
    this.preserveLineBreaks = false,
  });

  /// Emit a YAML front-matter block with title/author/source metadata.
  final bool frontMatter;

  /// How embedded pictures are handled.
  final ImageMode imageMode;

  /// Largest single image, in bytes, that will be inlined as a data URI.
  final int maxEmbeddedImageBytes;

  /// Insert `---` separators between PDF pages, slides and EPUB chapters.
  final bool pageSeparators;

  /// Include speaker notes, footnotes and review comments.
  final bool includeNotes;

  final BulletStyle bullet;

  /// Promote large PDF text runs to headings using relative font size.
  final bool detectPdfHeadings;

  /// Keep hard line breaks inside paragraphs instead of reflowing them.
  final bool preserveLineBreaks;

  String get bulletChar => bullet.char;

  ConvertOptions copyWith({
    bool? frontMatter,
    ImageMode? imageMode,
    int? maxEmbeddedImageBytes,
    bool? pageSeparators,
    bool? includeNotes,
    BulletStyle? bullet,
    bool? detectPdfHeadings,
    bool? preserveLineBreaks,
  }) {
    return ConvertOptions(
      frontMatter: frontMatter ?? this.frontMatter,
      imageMode: imageMode ?? this.imageMode,
      maxEmbeddedImageBytes: maxEmbeddedImageBytes ?? this.maxEmbeddedImageBytes,
      pageSeparators: pageSeparators ?? this.pageSeparators,
      includeNotes: includeNotes ?? this.includeNotes,
      bullet: bullet ?? this.bullet,
      detectPdfHeadings: detectPdfHeadings ?? this.detectPdfHeadings,
      preserveLineBreaks: preserveLineBreaks ?? this.preserveLineBreaks,
    );
  }

  Map<String, Object?> toJson() => {
        'frontMatter': frontMatter,
        'imageMode': imageMode.name,
        'maxEmbeddedImageBytes': maxEmbeddedImageBytes,
        'pageSeparators': pageSeparators,
        'includeNotes': includeNotes,
        'bullet': bullet.name,
        'detectPdfHeadings': detectPdfHeadings,
        'preserveLineBreaks': preserveLineBreaks,
      };

  factory ConvertOptions.fromJson(Map<String, Object?> json) {
    T pick<T>(String key, T fallback) => json[key] is T ? json[key] as T : fallback;
    return ConvertOptions(
      frontMatter: pick('frontMatter', true),
      imageMode: ImageMode.values.firstWhere(
        (mode) => mode.name == json['imageMode'],
        orElse: () => ImageMode.embed,
      ),
      maxEmbeddedImageBytes: pick('maxEmbeddedImageBytes', 512 * 1024),
      pageSeparators: pick('pageSeparators', true),
      includeNotes: pick('includeNotes', true),
      bullet: BulletStyle.values.firstWhere(
        (style) => style.name == json['bullet'],
        orElse: () => BulletStyle.hyphen,
      ),
      detectPdfHeadings: pick('detectPdfHeadings', true),
      preserveLineBreaks: pick('preserveLineBreaks', false),
    );
  }
}

class SourceFile {
  const SourceFile({required this.name, required this.bytes, this.mime = ''});

  final String name;
  final Uint8List bytes;
  final String mime;
}

/// What a single converter hands back before front matter is applied.
class RawOutput {
  const RawOutput({
    required this.markdown,
    this.meta = const {},
    this.warnings = const [],
    this.imageCount = 0,
  });

  final String markdown;
  final Map<String, String> meta;
  final List<String> warnings;
  final int imageCount;
}

class ConversionResult {
  const ConversionResult({
    required this.name,
    required this.outputName,
    required this.format,
    required this.markdown,
    required this.warnings,
    required this.meta,
    required this.imageCount,
    required this.wordCount,
    required this.durationMs,
  });

  final String name;
  final String outputName;
  final String format;
  final String markdown;
  final List<String> warnings;
  final Map<String, String> meta;
  final int imageCount;
  final int wordCount;
  final int durationMs;
}

/// Raised for input the converter understands but cannot process, with a
/// message written for the person holding the phone, not for a log file.
class ConversionException implements Exception {
  const ConversionException(this.message);

  final String message;

  @override
  String toString() => message;
}
