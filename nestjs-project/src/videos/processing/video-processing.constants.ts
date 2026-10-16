export const VIDEO_PROCESSING_QUEUE = 'video-processing';
export const PROCESS_VIDEO_JOB = 'process-video';

// Retention by count. While a job is retained its jobId blocks duplicates;
// once removed the id can be added again, so the DB status check stays the
// primary idempotency guard.
export const VIDEO_PROCESSING_KEEP_COMPLETED = 1000;
export const VIDEO_PROCESSING_KEEP_FAILED = 5000;

export interface ProcessVideoJobData {
  videoId: string;
}
