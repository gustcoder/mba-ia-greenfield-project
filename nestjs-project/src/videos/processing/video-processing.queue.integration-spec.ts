import { randomUUID } from 'crypto';
import { Test } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import { getQueueToken } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import Redis from 'ioredis';
import queueConfig from '../../config/queue.config';
import videosConfig from '../../config/videos.config';
import { QueueModule } from '../../queue/queue.module';
import {
  PROCESS_VIDEO_JOB,
  VIDEO_PROCESSING_KEEP_COMPLETED,
  VIDEO_PROCESSING_KEEP_FAILED,
  VIDEO_PROCESSING_QUEUE,
  type ProcessVideoJobData,
} from './video-processing.constants';
import { VideoProcessingQueueModule } from './video-processing-queue.module';
import { VideoProcessingQueue } from './video-processing.queue';

describe('VideoProcessingQueue (Redis)', () => {
  let producer: VideoProcessingQueue;
  let queue: Queue<ProcessVideoJobData>;
  let closeModule: () => Promise<void>;

  beforeAll(async () => {
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
    await module.init();
    producer = module.get(VideoProcessingQueue);
    queue = module.get<Queue<ProcessVideoJobData>>(
      getQueueToken(VIDEO_PROCESSING_QUEUE),
      { strict: false },
    );
    closeModule = () => module.close();
  });

  beforeEach(async () => {
    await queue.obliterate({ force: true });
  });

  afterAll(async () => {
    await queue.obliterate({ force: true });
    await closeModule();
  });

  it('should leave a process-video job whose id is the videoId, with the videoId payload', async () => {
    const videoId = randomUUID();

    await producer.enqueue(videoId);

    const job = await queue.getJob(videoId);
    expect(job).toBeDefined();
    expect(job!.id).toBe(videoId);
    expect(job!.name).toBe(PROCESS_VIDEO_JOB);
    expect(job!.data).toEqual({ videoId });
    expect(await job!.getState()).toBe('waiting');
  });

  it('should keep a single job when the same video is enqueued twice', async () => {
    const videoId = randomUUID();

    await producer.enqueue(videoId);
    await producer.enqueue(videoId);
    await Promise.all([producer.enqueue(videoId), producer.enqueue(videoId)]);

    const counts = await queue.getJobCounts();
    expect(counts.waiting).toBe(1);
    expect(await queue.getJobs(['waiting'])).toHaveLength(1);
  });

  it('should keep separate jobs for different videos', async () => {
    await producer.enqueue(randomUUID());
    await producer.enqueue(randomUUID());

    expect((await queue.getJobCounts()).waiting).toBe(2);
  });

  it('should apply attempts, exponential backoff and retention from the videos config', async () => {
    const videoId = randomUUID();
    const config = videosConfig();

    await producer.enqueue(videoId);

    const job = await queue.getJob(videoId);
    expect(job!.opts.attempts).toBe(config.processingAttempts);
    expect(job!.opts.backoff).toEqual({
      type: 'exponential',
      delay: config.processingBackoffMs,
    });
    expect(job!.opts.removeOnComplete).toBe(VIDEO_PROCESSING_KEEP_COMPLETED);
    expect(job!.opts.removeOnFail).toBe(VIDEO_PROCESSING_KEEP_FAILED);
  });

  it('should store its keys under the test prefix, never under the app prefix', async () => {
    const { host, port, prefix } = queueConfig();
    const redis = new Redis({ host, port });
    const appKeys = async () =>
      (await redis.keys(`bull:${VIDEO_PROCESSING_QUEUE}:*`)).sort();
    try {
      // The dev video-worker (Compose) keeps its own keys under the app
      // prefix in the same Redis, so "never" means: this run adds none.
      const before = await appKeys();

      await producer.enqueue(randomUUID());

      expect(prefix).toBe('bull-test');
      const testKeys = await redis.keys(
        `${prefix}:${VIDEO_PROCESSING_QUEUE}:*`,
      );
      expect(testKeys.length).toBeGreaterThan(0);
      expect(await appKeys()).toEqual(before);
    } finally {
      redis.disconnect();
    }
  });
});
