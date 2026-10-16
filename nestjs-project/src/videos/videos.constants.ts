export const ALLOWED_VIDEO_MIME_TYPES = [
  'video/mp4',
  'video/quicktime',
  'video/webm',
  'video/x-matroska',
] as const;

export const VIDEO_TITLE_MAX_LENGTH = 100;

export const MAX_PUBLIC_ID_ATTEMPTS = 5;

export function isAllowedVideoMimeType(value: string): boolean {
  return (ALLOWED_VIDEO_MIME_TYPES as readonly string[]).includes(value);
}

export const VideoFailureReason = {
  UPLOAD_EXPIRED: 'UPLOAD_EXPIRED',
  FILE_TOO_LARGE: 'FILE_TOO_LARGE',
  INVALID_MEDIA: 'INVALID_MEDIA',
  PROCESSING_FAILED: 'PROCESSING_FAILED',
} as const;
