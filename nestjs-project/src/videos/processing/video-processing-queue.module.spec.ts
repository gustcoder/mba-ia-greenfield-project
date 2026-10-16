import { Test } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import { getQueueToken } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import queueConfig from '../../config/queue.config';
import videosConfig from '../../config/videos.config';
import { QueueModule } from '../../queue/queue.module';
import { VIDEO_PROCESSING_QUEUE } from './video-processing.constants';
import { VideoProcessingQueueModule } from './video-processing-queue.module';
import { VideoProcessingQueue } from './video-processing.queue';

describe('VideoProcessingQueueModule', () => {
  it('should compile and resolve the producer and the registered queue', async () => {
    const module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          load: [queueConfig, videosConfig],
        }),
        QueueModule,
        VideoProcessingQueueModule,
      ],
    }).compile();

    expect(module.get(VideoProcessingQueue)).toBeInstanceOf(
      VideoProcessingQueue,
    );
    const queue = module.get<Queue>(getQueueToken(VIDEO_PROCESSING_QUEUE), {
      strict: false,
    });
    expect(queue.name).toBe(VIDEO_PROCESSING_QUEUE);
    await module.close();
  });
});
