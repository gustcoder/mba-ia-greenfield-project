import { Inject, Logger } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { InjectRepository } from '@nestjs/typeorm';
import { UnrecoverableError, type Job } from 'bullmq';
import { Repository } from 'typeorm';
import type { QueryDeepPartialEntity } from 'typeorm/query-builder/QueryPartialEntity';
import videosConfig from '../../config/videos.config';
import { InvalidMediaError } from '../../media/media.errors';
import { MediaService } from '../../media/media.service';
import { StorageService } from '../../storage/storage.service';
import { VideoStatus } from '../entities/video-status.enum';
import { Video } from '../entities/video.entity';
import { thumbnailKey } from '../video-storage-keys';
import { VideoFailureReason } from '../videos.constants';
import {
  VIDEO_PROCESSING_QUEUE,
  type ProcessVideoJobData,
} from './video-processing.constants';

// Runs in the worker process only (WorkerModule): the API registers the queue
// as a producer but never this consumer.
@Processor(VIDEO_PROCESSING_QUEUE)
export class VideoProcessingProcessor extends WorkerHost {
  private readonly logger = new Logger(VideoProcessingProcessor.name);

  constructor(
    @InjectRepository(Video)
    private readonly videoRepository: Repository<Video>,
    private readonly storage: StorageService,
    private readonly media: MediaService,
    @Inject(videosConfig.KEY)
    private readonly config: ConfigType<typeof videosConfig>,
  ) {
    super();
  }

  // At-least-once delivery: a job for a video that is gone or no longer
  // processing (already ready, failed, redelivered) completes with no effect.
  async process(job: Job<ProcessVideoJobData>): Promise<void> {
    const video = await this.videoRepository.findOneBy({
      id: job.data.videoId,
    });
    if (!video || video.status !== VideoStatus.PROCESSING) {
      this.logger.log(
        `Skipping job ${job.id}: video ${job.data.videoId} is ${video?.status ?? 'missing'}`,
      );
      return;
    }

    try {
      await this.processVideo(video);
    } catch (error) {
      await this.handleFailure(job, video, error);
    }
  }

  private async processVideo(video: Video): Promise<void> {
    // Internal-endpoint URL: ffprobe/ffmpeg read the object by ranged requests
    // instead of copying up to 10GB to the worker disk (TD-04).
    const sourceUrl = await this.storage.presignInternalGet(
      video.storage_key,
      this.config.sourceUrlTtlSeconds,
    );
    const probe = await this.media.probe(sourceUrl);
    const thumbnail = await this.media.extractThumbnail(
      sourceUrl,
      probe.durationSeconds,
    );
    const key = thumbnailKey(video.id);
    await this.storage.putObject(key, thumbnail, 'image/jpeg');

    // One statement closes the cycle; guarded by the status so a video that
    // changed meanwhile is not overwritten.
    await this.videoRepository.update(
      { id: video.id, status: VideoStatus.PROCESSING },
      {
        duration_seconds: probe.durationSeconds,
        width: probe.width,
        height: probe.height,
        video_codec: probe.videoCodec,
        ...(probe.sizeBytes > 0 && { size_bytes: String(probe.sizeBytes) }),
        // TypeORM's deep-partial type cannot express an arbitrary jsonb object.
        metadata: probe.metadata as QueryDeepPartialEntity<Video>['metadata'],
        thumbnail_key: key,
        status: VideoStatus.READY,
        failure_reason: null,
      },
    );
  }

  private async handleFailure(
    job: Job<ProcessVideoJobData>,
    video: Video,
    error: unknown,
  ): Promise<never> {
    const message = error instanceof Error ? error.message : String(error);

    if (error instanceof InvalidMediaError) {
      await this.markFailed(video, VideoFailureReason.INVALID_MEDIA);
      this.logger.warn(`Video ${video.id} is not valid media: ${message}`);
      // Permanent: retrying the same bytes cannot succeed.
      throw new UnrecoverableError(message);
    }

    const attempts = job.opts.attempts ?? 1;
    const isLastAttempt = job.attemptsMade + 1 >= attempts;
    this.logger.error(
      `Processing video ${video.id} failed (attempt ${job.attemptsMade + 1}/${attempts}): ${message}`,
    );
    if (isLastAttempt) {
      await this.markFailed(video, VideoFailureReason.PROCESSING_FAILED);
    }
    throw error;
  }

  private async markFailed(video: Video, reason: string): Promise<void> {
    await this.videoRepository.update(
      { id: video.id, status: VideoStatus.PROCESSING },
      { status: VideoStatus.FAILED, failure_reason: reason },
    );
  }
}
