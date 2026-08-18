/** Byte → text decoding with BOM sniffing and a Windows-1252 fallback. */
export function decodeText(bytes, hintedCharset) {
    if (bytes.length === 0)
        return { text: '', encoding: 'utf-8' };
    if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
        return { text: new TextDecoder('utf-8').decode(bytes.subarray(3)), encoding: 'utf-8' };
    }
    if (bytes[0] === 0xff && bytes[1] === 0xfe) {
        return { text: decodeUtf16(bytes.subarray(2), true), encoding: 'utf-16le' };
    }
    if (bytes[0] === 0xfe && bytes[1] === 0xff) {
        return { text: decodeUtf16(bytes.subarray(2), false), encoding: 'utf-16be' };
    }
    const charset = (hintedCharset ?? '').toLowerCase().replace(/["']/g, '');
    if (charset && charset !== 'utf-8' && charset !== 'utf8') {
        try {
            return { text: new TextDecoder(charset).decode(bytes), encoding: charset };
        }
        catch {
            // Unknown label: fall through to the sniffing path.
        }
    }
    try {
        return { text: new TextDecoder('utf-8', { fatal: true }).decode(bytes), encoding: 'utf-8' };
    }
    catch {
        return { text: new TextDecoder('windows-1252').decode(bytes), encoding: 'windows-1252' };
    }
}
function decodeUtf16(bytes, littleEndian) {
    let out = '';
    for (let i = 0; i + 1 < bytes.length; i += 2) {
        out += String.fromCharCode(littleEndian ? bytes[i] | (bytes[i + 1] << 8) : (bytes[i] << 8) | bytes[i + 1]);
    }
    return out;
}
/** Heuristic: does this payload look like text rather than a binary blob? */
export function looksTextual(bytes) {
    const sample = bytes.subarray(0, Math.min(bytes.length, 4096));
    let control = 0;
    for (const byte of sample) {
        if (byte === 0)
            return false;
        if (byte < 0x09 || (byte > 0x0d && byte < 0x20))
            control++;
    }
    return control / Math.max(1, sample.length) < 0.05;
}
//# sourceMappingURL=decode.js.map