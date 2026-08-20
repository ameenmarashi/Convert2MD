/**
 * The File System Access API's save side isn't in TypeScript's bundled DOM
 * lib — `FileSystemFileHandle` and friends are, `showSaveFilePicker` isn't.
 * Chrome, Edge and Chrome-on-Android implement it; Safari and Firefox don't,
 * which is why callers feature-detect before using it.
 */

interface FileSystemAccessAcceptOption {
  description?: string;
  accept: Record<string, string[]>;
}

interface SaveFilePickerOptions {
  suggestedName?: string;
  types?: FileSystemAccessAcceptOption[];
  excludeAcceptAllOption?: boolean;
}

interface Window {
  showSaveFilePicker?(options?: SaveFilePickerOptions): Promise<FileSystemFileHandle>;
}
