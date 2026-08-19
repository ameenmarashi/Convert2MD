/**
 * Photos, embedded in the document itself.
 *
 * A Markdown file is one file, and the point of this app is that it stays one
 * file — so a picture goes inside it as a data URI rather than beside it as a
 * second file the user has to remember to carry around. That is also what keeps
 * the privacy promise intact: the picture never leaves the device, because it
 * never leaves the document.
 *
 * The cost is size, and a phone photo is 4 MB before it starts. So every
 * picture is scaled down and re-encoded here, dropping quality a step at a time
 * until it fits a budget a text file can carry.
 */

const MAX_EDGE = 1600;
const BUDGET = 1_200_000;
/** Longest edge and JPEG quality, tried in order until one fits the budget. */
const STEPS: { edge: number; quality: number }[] = [
  { edge: MAX_EDGE, quality: 0.82 },
  { edge: 1200, quality: 0.72 },
  { edge: 900, quality: 0.62 },
  { edge: 640, quality: 0.55 },
];

export interface EmbeddedPhoto {
  alt: string;
  src: string;
}

/**
 * Reads a picture the user chose and returns it as something a Markdown file
 * can hold. Returns null for a file that is not an image, or one the browser
 * cannot decode.
 */
export async function embedPhoto(file: File): Promise<EmbeddedPhoto | null> {
  const alt = altFor(file.name);
  if (file.type && !file.type.startsWith('image/')) return null;

  // SVG is text and already resolution-independent; rasterising it would only
  // make it worse and bigger.
  if (file.type === 'image/svg+xml') {
    const src = await readDataUrl(file);
    return src ? { alt, src } : null;
  }

  const source = await decode(file);
  if (!source) return null;

  try {
    const keepsType = file.type === 'image/png' || file.type === 'image/gif';
    // An animated GIF loses its animation on a canvas, and a small picture has
    // nothing to gain from being re-encoded, so both are taken as they are.
    if (file.size <= BUDGET && (file.type === 'image/gif' || withinBounds(source, MAX_EDGE))) {
      const src = await readDataUrl(file);
      if (src) return { alt, src };
    }

    const type = keepsType ? 'image/png' : 'image/jpeg';
    for (const step of STEPS) {
      const src = draw(source, step.edge, type, step.quality);
      if (!src) continue;
      if (src.length <= BUDGET || step === STEPS[STEPS.length - 1]) return { alt, src };
    }
    return null;
  } finally {
    release(source);
  }
}

type Decoded = ImageBitmap | HTMLImageElement;

function withinBounds(source: Decoded, edge: number): boolean {
  return Math.max(source.width, source.height) <= edge;
}

/**
 * `createImageBitmap` is the fast path and handles most formats; an `<img>` is
 * the fallback, and on iOS it is also the only one that reads a HEIC photo
 * straight from the camera roll.
 */
async function decode(file: File): Promise<Decoded | null> {
  if (typeof createImageBitmap === 'function') {
    try {
      return await createImageBitmap(file);
    } catch {
      // Fall through to the <img> path.
    }
  }

  const url = URL.createObjectURL(file);
  try {
    return await new Promise<HTMLImageElement>((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = () => reject(new Error('decode failed'));
      image.src = url;
    });
  } catch {
    return null;
  } finally {
    // The element keeps its own decoded copy, so the URL is finished with.
    URL.revokeObjectURL(url);
  }
}

function release(source: Decoded): void {
  if (typeof ImageBitmap !== 'undefined' && source instanceof ImageBitmap) source.close();
}

function draw(source: Decoded, edge: number, type: string, quality: number): string | null {
  const scale = Math.min(1, edge / Math.max(source.width, source.height));
  const width = Math.max(1, Math.round(source.width * scale));
  const height = Math.max(1, Math.round(source.height * scale));

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  if (!context) return null;

  // JPEG has no transparency, so anything see-through would come out black.
  if (type === 'image/jpeg') {
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, width, height);
  }
  context.drawImage(source, 0, 0, width, height);

  try {
    const url = canvas.toDataURL(type, quality);
    // A browser that cannot write the type asked for silently gives back PNG,
    // which is fine — it is still a picture the document can hold.
    return url.startsWith('data:image/') ? url : null;
  } catch {
    return null;
  }
}

function readDataUrl(file: File): Promise<string | null> {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : null);
    reader.onerror = () => resolve(null);
    reader.readAsDataURL(file);
  });
}

/**
 * The file name makes the alt text: it is what the person who added the picture
 * already called it, and an empty alt is worse than an approximate one.
 */
export function altFor(fileName: string): string {
  const base = fileName.replace(/\.[^.]+$/, '').replace(/[[\]()\\]/g, ' ').replace(/[_-]+/g, ' ');
  const cleaned = base.replace(/\s+/g, ' ').trim();
  return cleaned || 'photo';
}

/** How much a data URI adds to a document, in a form worth showing a person. */
export function describeSize(bytes: number): string {
  if (bytes >= 1_000_000) return `${(bytes / 1_000_000).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1000))} KB`;
}
