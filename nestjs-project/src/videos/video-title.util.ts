import { parse } from 'path';
import { VIDEO_TITLE_MAX_LENGTH } from './videos.constants';

// Truncates by code point: PostgreSQL varchar(n) counts characters, and a cut
// through a surrogate pair would produce an invalid string.
export function truncateTitle(value: string): string {
  return Array.from(value).slice(0, VIDEO_TITLE_MAX_LENGTH).join('');
}

// Default title = file name without its extension; falls back to the whole
// name when nothing is left (e.g. ".mp4").
export function deriveTitleFromFilename(filename: string): string {
  const name = parse(filename).name.trim();
  return truncateTitle(name.length > 0 ? name : filename.trim());
}
