/** Shared conversion contract. The Dart port mirrors these names exactly. */
export const DEFAULT_OPTIONS = {
    frontMatter: true,
    imageMode: 'embed',
    maxEmbeddedImageBytes: 512 * 1024,
    pageSeparators: true,
    includeNotes: true,
    bullet: '-',
    detectPdfHeadings: true,
    preserveLineBreaks: false,
};
export class ConversionError extends Error {
    constructor(message) {
        super(message);
        this.name = 'ConversionError';
    }
}
//# sourceMappingURL=types.js.map