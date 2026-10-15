import { randomUUID } from 'crypto';
import { readFile } from 'fs/promises';
import { Test } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import { getQueueToken } from '@nestjs/bullmq';
import { getRepositoryToken, TypeOrmModule } from '@nestjs/typeorm';
import { UnrecoverableError, type Job, type Queue } from 'bullmq';
import { DataSource, Repository } from 'typeorm';
import { RefreshToken } from '../../auth/entities/refresh-token.entity';
import { VerificationToken } from '../../auth/entities/verification-token.entity';
import { Channel } from '../../channels/entities/channel.entity';
import queueConfig from '../../config/queue.config';
import storageConfig from '../../config/storage.config';
import videosConfig from '../../config/videos.config';
import { MediaModule } from '../../media/media.module';
import { MediaService } from '../../media/media.service';
import { QueueModule } from '../../queue/queue.module';
import { StorageModule } from '../../storage/storage.module';
import { StorageService } from '../../storage/storage.service';
import {
  cleanAllTables,
  createTestDataSource,
} from '../../test/create-test-data-source';
import {
  createVideoFixtures,
  FIXTURE_VIDEO,
  type VideoFixtures,
} from '../../test/video-fixtures';
import { User } from '../../users/entities/user.entity';
import { VideoStatus } from '../entities/video-status.enum';
import { Video } from '../entities/video.entity';
import { generatePublicId } from '../public-id.util';
import {
  VIDEO_PROCESSING_QUEUE,
  type ProcessVideoJobData,
} from './video-processing.constants';
import { VideoProcessingQueue } from './video-processing.queue';
import { VideoProcessingQueueModule } from './video-processing-queue.module';
import { VideoProcessingProcessor } from './video-processing.processor';

const ALL_ENTITIES = [User, Channel, RefreshToken, VerificationToken, Video];
const ATTEMPTS = 2;

// Real Postgres, MinIO, ffmpeg, Redis. The module also runs the real BullMQ
// worker (init), so the retry tests exercise the attempt counting of BullMQ
// itself; they use a short backoff and 2 attempts instead of 10 s and 3.
describe('VideoProcessingProcessor (Postgres + MinIO + ffmpeg + Redis)', () => {
  let processor: VideoProcessingProcessor;
  let producer: VideoProcessingQueue;
  let queue: Queue<ProcessVideoJobData>;
  let storage: StorageService;
  let media: MediaService;
  let dataSource: DataSource;
  let videoRepository: Repository<Video>;
  let fixtures: VideoFixtures;
  let closeModule: () => Promise<void>;
  let counter = 0;

  beforeAll(async () => {
    fixtures = await createVideoFixtures();
    const module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          load: [storageConfig, queueConfig, videosConfig],
        }),
        TypeOrmModule.forRoot(createTestDataSource(ALL_ENTITIES).options),
        TypeOrmModule.forFeature([Video]),
        QueueModule,
        VideoProcessingQueueModule,
        StorageModule,
        MediaModule,
      ],
      providers: [VideoProcessingProcessor],
    })
      .overrideProvider(videosConfig.KEY)
      .useValue({
        ...videosConfig(),
        processingAttempts: ATTEMPTS,
        processingBackoffMs: 50,
      })
      .compile();
    await module.init();
    processor = module.get(VideoProcessingProcessor);
    producer = module.get(VideoProcessingQueue);
    queue = module.get<Queue<ProcessVideoJobData>>(
      getQueueToken(VIDEO_PROCESSING_QUEUE),
      { strict: false },
    );
    storage = module.get(StorageService);
    media = module.get(MediaService);
    dataSource = module.get(DataSource);
    videoRepository = module.get(getRepositoryToken(Video));
    closeModule = () => module.close();
  });

  beforeEach(async () => {
    jest.restoreAllMocks();
    await cleanAllTables(dataSource);
    await queue.obliterate({ force: true });
  });

  afterAll(async () => {
    await queue.obliterate({ force: true });
    await storage.deletePrefix('videos/');
    await fixtures.cleanup();
    await closeModule();
  });

  async function createProcessingVideo(
    filePath: string | null,
    contentType = 'video/mp4',
  ): Promise<Video> {
    counter += 1;
    const user = await dataSource.getRepository(User).save(
      dataSource.getRepository(User).create({
        email: `worker_${counter}@example.com`,
        password: 'x',
      }),
    );
    const channel = await dataSource.getRepository(Channel).save(
      dataSource.getRepository(Channel).create({
        name: `Worker ${counter}`,
        nickname: `worker_${counter}`,
        user_id: user.id,
      }),
    );
    const id = randomUUID();
    const key = `videos/${id}/original`;
    if (filePath) {
      await storage.putObject(key, await readFile(filePath), contentType);
    }
    return videoRepository.save(
      videoRepository.create({
        id,
        public_id: generatePublicId(),
        channel_id: channel.id,
        title: 'aula',
        original_filename: 'aula.mp4',
        mime_type: 'video/mp4',
        size_bytes: '1',
        storage_key: key,
        part_size_bytes: 104857600,
        part_count: 1,
        status: VideoStatus.PROCESSING,
      }),
    );
  }

  const fakeJob = (video: Video): Job<ProcessVideoJobData> =>
    ({
      id: video.id,
      data: { videoId: video.id },
      attemptsMade: 0,
      opts: { attempts: ATTEMPTS },
    }) as unknown as Job<ProcessVideoJobData>;

  async function waitFor(
    id: string,
    done: (video: Video) => boolean,
  ): Promise<Video> {
    const deadline = Date.now() + 20000;
    for (;;) {
      const video = await videoRepository.findOneByOrFail({ id });
      if (done(video)) return video;
      if (Date.now() > deadline) {
        throw new Error(`Timed out waiting on video ${id}: ${video.status}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  describe('process()', () => {
    it('should leave a real video ready with its metadata and a JPEG thumbnail in the storage', async () => {
      const video = await createProcessingVideo(fixtures.videoPath);

      await processor.process(fakeJob(video));

      const after = await videoRepository.findOneByOrFail({ id: video.id });
      expect(after).toMatchObject({
        status: VideoStatus.READY,
        failure_reason: null,
        width: FIXTURE_VIDEO.width,
        height: FIXTURE_VIDEO.height,
        video_codec: FIXTURE_VIDEO.codec,
        thumbnail_key: `videos/${video.id}/thumbnail.jpg`,
      });
      expect(after.duration_seconds).toBeCloseTo(
        FIXTURE_VIDEO.durationSeconds,
        0,
      );
      expect(Number(after.size_bytes)).toBeGreaterThan(1);
      const { streams } = after.metadata as {
        streams: { codec_type: string }[];
      };
      expect(streams[0].codec_type).toBe('video');

      const thumbnail = await fetch(
        await storage.presignInternalGet(after.thumbnail_key as string, 60),
      );
      const bytes = Buffer.from(await thumbnail.arrayBuffer());
      expect([...bytes.subarray(0, 2)]).toEqual([0xff, 0xd8]);
    });

    it('should fail a non-video file as INVALID_MEDIA with an unrecoverable job error', async () => {
      const video = await createProcessingVideo(
        fixtures.notVideoPath,
        'text/plain',
      );

      await expect(processor.process(fakeJob(video))).rejects.toBeInstanceOf(
        UnrecoverableError,
      );

      const after = await videoRepository.findOneByOrFail({ id: video.id });
      expect(after).toMatchObject({
        status: VideoStatus.FAILED,
        failure_reason: 'INVALID_MEDIA',
        thumbnail_key: null,
      });
    });

    it('should leave an already ready video untouched when its job is redelivered', async () => {
      const video = await createProcessingVideo(fixtures.videoPath);
      await processor.process(fakeJob(video));
      const ready = await videoRepository.findOneByOrFail({ id: video.id });
      const probe = jest.spyOn(media, 'probe');

      await processor.process(fakeJob(video));

      expect(probe).not.toHaveBeenCalled();
      const after = await videoRepository.findOneByOrFail({ id: video.id });
      expect(after.updated_at).toEqual(ready.updated_at);
      expect(after.status).toBe(VideoStatus.READY);
    });
  });

  describe('through the real queue and worker', () => {
    it('should take an enqueued video from processing to ready on its own', async () => {
      const video = await createProcessingVideo(fixtures.videoPath);

      await producer.enqueue(video.id);

      const after = await waitFor(
        video.id,
        (v) => v.status !== VideoStatus.PROCESSING,
      );
      expect(after.status).toBe(VideoStatus.READY);
      expect(after.thumbnail_key).toBe(`videos/${video.id}/thumbnail.jpg`);
    });

    it('should fail an enqueued non-video after a single attempt', async () => {
      const video = await createProcessingVideo(
        fixtures.notVideoPath,
        'text/plain',
      );
      const probe = jest.spyOn(media, 'probe');

      await producer.enqueue(video.id);

      const after = await waitFor(
        video.id,
        (v) => v.status !== VideoStatus.PROCESSING,
      );
      expect(after).toMatchObject({
        status: VideoStatus.FAILED,
        failure_reason: 'INVALID_MEDIA',
      });
      expect(probe).toHaveBeenCalledTimes(1);
    });

    it('should retry with backoff when the object cannot be read and then fail as PROCESSING_FAILED', async () => {
      // No object in the storage: ffprobe gets a 404, a transient failure.
      const video = await createProcessingVideo(null);
      const probe = jest.spyOn(media, 'probe');

      await producer.enqueue(video.id);

      const after = await waitFor(
        video.id,
        (v) => v.status !== VideoStatus.PROCESSING,
      );
      expect(after).toMatchObject({
        status: VideoStatus.FAILED,
        failure_reason: 'PROCESSING_FAILED',
      });
      expect(probe).toHaveBeenCalledTimes(ATTEMPTS);
    });

    it('should recover on the retry when the storage comes back', async () => {
      const video = await createProcessingVideo(null);
      jest
        .spyOn(media, 'probe')
        .mockImplementationOnce(() =>
          Promise.reject(new Error('storage unavailable')),
        );
      await storage.putObject(
        video.storage_key,
        await readFile(fixtures.videoPath),
        'video/mp4',
      );

      await producer.enqueue(video.id);

      const after = await waitFor(
        video.id,
        (v) => v.status !== VideoStatus.PROCESSING,
      );
      expect(after.status).toBe(VideoStatus.READY);
    });
  });
});
