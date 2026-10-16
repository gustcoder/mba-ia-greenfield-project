import { Module } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { BullModule } from '@nestjs/bullmq';
import videosConfig from '../../config/videos.config';
import {
  VIDEO_PROCESSING_KEEP_COMPLETED,
  VIDEO_PROCESSING_KEEP_FAILED,
  VIDEO_PROCESSING_QUEUE,
} from './video-processing.constants';
import { VideoProcessingQueue } from './video-processing.queue';

@Module({
  imports: [
    BullModule.registerQueueAsync({
      name: VIDEO_PROCESSING_QUEUE,
      inject: [videosConfig.KEY],
      useFactory: (config: ConfigType<typeof videosConfig>) => ({
        defaultJobOptions: {
          attempts: config.processingAttempts,
          backoff: { type: 'exponential', delay: config.processingBackoffMs },
          removeOnComplete: VIDEO_PROCESSING_KEEP_COMPLETED,
          removeOnFail: VIDEO_PROCESSING_KEEP_FAILED,
        },
      }),
    }),
  ],
  providers: [VideoProcessingQueue],
  exports: [VideoProcessingQueue],
})
export class VideoProcessingQueueModule {}
