export const FFPROBE_BINARY = 'ffprobe';
export const FFMPEG_BINARY = 'ffmpeg';

// Generous: with an http(s) input every seek is a ranged request to the
// storage, but a stuck process must still end instead of blocking the worker.
export const PROBE_TIMEOUT_MS = 60_000;
export const THUMBNAIL_TIMEOUT_MS = 120_000;

// A JSON document or one JPEG; anything bigger means something is wrong.
export const MAX_RUNNER_STDOUT_BYTES = 50 * 1024 * 1024;
export const MAX_RUNNER_STDERR_CHARS = 16 * 1024;

export const THUMBNAIL_SEEK_RATIO = 0.1;
export const THUMBNAIL_MAX_WIDTH = 1280;

// ffprobe will happily read plain text as a "video" (the `tty` demuxer turns
// ANSI text into frames), so the container must be one the upload allowlist
// can produce: mp4/quicktime (mov family) and webm/matroska.
export const ALLOWED_CONTAINER_FORMATS = ['mov', 'matroska', 'webm'] as const;
