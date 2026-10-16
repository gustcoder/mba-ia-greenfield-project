import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { UnrecoverableError, type Job } from 'bullmq';
import videosConfig from '../../config/videos.config';
import {
  FfmpegExecutionError,
  InvalidMediaError,
} from '../../media/media.errors';
import { MediaService } from '../../media/media.service';
import { StorageService } from '../../storage/storage.service';
import { VideoStatus } from '../entities/video-status.enum';
import { Video } from '../entities/video.entity';
import type { ProcessVideoJobData } from './video-processing.constants';
import { VideoProcessingProcessor } from './video-processing.processor';

const VIDEO_ID = 'video-uuid';
const SOURCE_URL = 'http://minio:9000/bucket/videos/video-uuid/original?sig=1';
const JPEG = Buffer.from([0xff, 0xd8, 0xff]);

const job = (attemptsMade = 0, attempts = 3) =>
  ({
    id: VIDEO_ID,
    data: { videoId: VIDEO_ID },
    attemptsMade,
    opts: { attempts },
  }) as unknown as Job<ProcessVideoJobData>;

const probeResult = {
  durationSeconds: 3,
  width: 640,
  height: 360,
  videoCodec: 'h264',
  sizeBytes: 5000,
  metadata: { format: { format_name: 'mov,mp4' }, streams: [] },
};

describe('VideoProcessingProcessor', () => {
  const repository = { findOneBy: jest.fn(), update: jest.fn() };
  const storage = { presignInternalGet: jest.fn(), putObject: jest.fn() };
  const media = { probe: jest.fn(), extractThumbnail: jest.fn() };
  let processor: VideoProcessingProcessor;

  const processingVideo = (overrides: Partial<Video> = {}): Video =>
    ({
      id: VIDEO_ID,
      status: VideoStatus.PROCESSING,
      storage_key: 'videos/video-uuid/original',
      ...overrides,
    }) as Video;

  beforeEach(async () => {
    repository.findOneBy.mockReset().mockResolvedValue(processingVideo());
    repository.update.mockReset().mockResolvedValue({ affected: 1 });
    storage.presignInternalGet.mockReset().mockResolvedValue(SOURCE_URL);
    storage.putObject.mockReset().mockResolvedValue(undefined);
    media.probe.mockReset().mockResolvedValue(probeResult);
    media.extractThumbnail.mockReset().mockResolvedValue(JPEG);

    const module = await Test.createTestingModule({
      providers: [
        VideoProcessingProcessor,
        { provide: getRepositoryToken(Video), useValue: repository },
        { provide: StorageService, useValue: storage },
        { provide: MediaService, useValue: media },
        { provide: videosConfig.KEY, useValue: { sourceUrlTtlSeconds: 21600 } },
      ],
    }).compile();
    processor = module.get(VideoProcessingProcessor);
  });

  describe('skipped jobs', () => {
    it('should complete without effect when the video no longer exists', async () => {
      repository.findOneBy.mockResolvedValue(null);

      await expect(processor.process(job())).resolves.toBeUndefined();

      expect(storage.presignInternalGet).not.toHaveBeenCalled();
      expect(repository.update).not.toHaveBeenCalled();
    });

    it.each([VideoStatus.DRAFT, VideoStatus.READY, VideoStatus.FAILED])(
      'should complete without effect when the video is %s',
      async (status) => {
        repository.findOneBy.mockResolvedValue(processingVideo({ status }));

        await expect(processor.process(job())).resolves.toBeUndefined();

        expect(media.probe).not.toHaveBeenCalled();
        expect(storage.putObject).not.toHaveBeenCalled();
        expect(repository.update).not.toHaveBeenCalled();
      },
    );
  });

  describe('success', () => {
    it('should probe the internal presigned url, store the thumbnail and mark the video ready in one update', async () => {
      await processor.process(job());

      expect(storage.presignInternalGet).toHaveBeenCalledWith(
        'videos/video-uuid/original',
        21600,
      );
      expect(media.probe).toHaveBeenCalledWith(SOURCE_URL);
      expect(media.extractThumbnail).toHaveBeenCalledWith(SOURCE_URL, 3);
      expect(storage.putObject).toHaveBeenCalledWith(
        'videos/video-uuid/thumbnail.jpg',
        JPEG,
        'image/jpeg',
      );
      expect(repository.update).toHaveBeenCalledTimes(1);
      expect(repository.update).toHaveBeenCalledWith(
        { id: VIDEO_ID, status: VideoStatus.PROCESSING },
        {
          duration_seconds: 3,
          width: 640,
          height: 360,
          video_codec: 'h264',
          size_bytes: '5000',
          metadata: probeResult.metadata,
          thumbnail_key: 'videos/video-uuid/thumbnail.jpg',
          status: VideoStatus.READY,
          failure_reason: null,
        },
      );
    });

    it('should keep the confirmed size when ffprobe reports none', async () => {
      media.probe.mockResolvedValue({ ...probeResult, sizeBytes: 0 });

      await processor.process(job());

      const [, changes] = repository.update.mock.calls[0] as [
        unknown,
        Record<string, unknown>,
      ];
      expect(changes).not.toHaveProperty('size_bytes');
    });

    it('should store the thumbnail before flipping the video to ready', async () => {
      const order: string[] = [];
      storage.putObject.mockImplementation(() => {
        order.push('thumbnail');
        return Promise.resolve();
      });
      repository.update.mockImplementation(() => {
        order.push('ready');
        return Promise.resolve({ affected: 1 });
      });

      await processor.process(job());

      expect(order).toEqual(['thumbnail', 'ready']);
    });
  });

  describe('invalid media', () => {
    it('should mark the video failed/INVALID_MEDIA and fail the job without retries', async () => {
      media.probe.mockRejectedValue(new InvalidMediaError('No video stream'));

      await expect(processor.process(job())).rejects.toBeInstanceOf(
        UnrecoverableError,
      );

      expect(repository.update).toHaveBeenCalledWith(
        { id: VIDEO_ID, status: VideoStatus.PROCESSING },
        { status: VideoStatus.FAILED, failure_reason: 'INVALID_MEDIA' },
      );
      expect(storage.putObject).not.toHaveBeenCalled();
    });

    it('should fail as INVALID_MEDIA on the first attempt even with retries left', async () => {
      media.probe.mockRejectedValue(new InvalidMediaError('nope'));

      await expect(processor.process(job(0, 5))).rejects.toBeInstanceOf(
        UnrecoverableError,
      );

      expect(repository.update).toHaveBeenCalledTimes(1);
    });
  });

  describe('transient failures', () => {
    const transient = () =>
      new FfmpegExecutionError('connection refused', 'exit-code', '', 1);

    it('should only rethrow on an intermediate attempt, leaving the video processing', async () => {
      const error = transient();
      media.probe.mockRejectedValue(error);

      const failure: unknown = await processor
        .process(job(0, 3))
        .catch((e: unknown) => e);

      expect(failure).toBe(error);
      expect(repository.update).not.toHaveBeenCalled();
    });

    it('should still be retryable on the second of three attempts', async () => {
      media.probe.mockRejectedValue(transient());

      await expect(processor.process(job(1, 3))).rejects.toBeInstanceOf(
        FfmpegExecutionError,
      );

      expect(repository.update).not.toHaveBeenCalled();
    });

    it('should mark the video failed/PROCESSING_FAILED before rethrowing on the last attempt', async () => {
      const error = transient();
      media.probe.mockRejectedValue(error);

      const failure: unknown = await processor
        .process(job(2, 3))
        .catch((e: unknown) => e);

      expect(failure).toBe(error);
      expect(repository.update).toHaveBeenCalledWith(
        { id: VIDEO_ID, status: VideoStatus.PROCESSING },
        { status: VideoStatus.FAILED, failure_reason: 'PROCESSING_FAILED' },
      );
    });

    it('should treat a job without attempts option as a single attempt', async () => {
      media.probe.mockRejectedValue(transient());
      const single = job(0, 3);
      single.opts = {};

      await expect(processor.process(single)).rejects.toBeInstanceOf(
        FfmpegExecutionError,
      );

      expect(repository.update).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ failure_reason: 'PROCESSING_FAILED' }),
      );
    });

    it('should fail the attempt, not mark ready, when storing the thumbnail fails', async () => {
      storage.putObject.mockRejectedValue(new Error('storage down'));

      await expect(processor.process(job(0, 3))).rejects.toThrow(
        'storage down',
      );

      expect(repository.update).not.toHaveBeenCalled();
    });
  });
});
