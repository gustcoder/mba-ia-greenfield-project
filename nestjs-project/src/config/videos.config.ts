import { registerAs } from '@nestjs/config';

export default registerAs('videos', () => ({
  maxSizeBytes: parseInt(process.env.VIDEO_MAX_SIZE_BYTES || '10737418240', 10),
  uploadPartSizeBytes: parseInt(
    process.env.VIDEO_UPLOAD_PART_SIZE_BYTES || '104857600',
    10,
  ),
  uploadUrlTtlSeconds: parseInt(
    process.env.VIDEO_UPLOAD_URL_TTL_SECONDS || '3600',
    10,
  ),
  playbackUrlTtlSeconds: parseInt(
    process.env.VIDEO_PLAYBACK_URL_TTL_SECONDS || '3600',
    10,
  ),
  sourceUrlTtlSeconds: parseInt(
    process.env.VIDEO_SOURCE_URL_TTL_SECONDS || '21600',
    10,
  ),
  processingAttempts: parseInt(
    process.env.VIDEO_PROCESSING_ATTEMPTS || '3',
    10,
  ),
  processingBackoffMs: parseInt(
    process.env.VIDEO_PROCESSING_BACKOFF_MS || '10000',
    10,
  ),
}));
