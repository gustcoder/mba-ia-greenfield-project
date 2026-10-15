const PLAIN_ASCII_FILENAME = /^[\x20-\x7e]*$/;

export function buildAttachmentDisposition(filename: string): string {
  const isPlain =
    PLAIN_ASCII_FILENAME.test(filename) && !/["\\]/.test(filename);
  if (isPlain) {
    return `attachment; filename="${filename}"`;
  }
  const fallback = filename.replace(/[^\x20-\x7e]|["\\]/g, '_');
  const encoded = encodeURIComponent(filename).replace(
    /['()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}
