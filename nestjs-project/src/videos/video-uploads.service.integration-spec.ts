import { Test } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import { getRepositoryToken, TypeOrmModule } from '@nestjs/typeorm';
import { getQueueToken } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import { DataSource, Repository } from 'typeorm';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { VerificationToken } from '../auth/entities/verification-token.entity';
import { Channel } from '../channels/entities/channel.entity';
import storageConfig from '../config/storage.config';
import queueConfig from '../config/queue.config';
import videosConfig from '../config/videos.config';
import { QueueModule } from '../queue/queue.module';
import { StorageUploadNotFoundError } from '../storage/storage.errors';
import {
  InvalidPartNumberException,
  InvalidUploadPartsException,
  InvalidUploadStateException,
  UploadExpiredException,
  VideoNotFoundException,
} from './exceptions/video.exceptions';
import { StorageService } from '../storage/storage.service';
import {
  cleanAllTables,
  createTestDataSource,
} from '../test/create-test-data-source';
import { User } from '../users/entities/user.entity';
import { VideoStatus } from './entities/video-status.enum';
import { Video } from './entities/video.entity';
import {
  VIDEO_PROCESSING_QUEUE,
  type ProcessVideoJobData,
} from './processing/video-processing.constants';
import * as publicIdUtil from './public-id.util';
import { VideoUploadsService } from './video-uploads.service';
import { VideosModule } from './videos.module';

const ALL_ENTITIES = [User, Channel, RefreshToken, VerificationToken, Video];

describe('VideoUploadsService.initiate (Postgres + MinIO)', () => {
  let service: VideoUploadsService;
  let storage: StorageService;
  let dataSource: DataSource;
  let videoRepository: Repository<Video>;
  let queue: Queue<ProcessVideoJobData>;
  let closeModule: () => Promise<void>;

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          load: [storageConfig, videosConfig, queueConfig],
        }),
        TypeOrmModule.forRoot(createTestDataSource(ALL_ENTITIES).options),
        QueueModule,
        VideosModule,
      ],
    }).compile();
    await module.init();
    service = module.get(VideoUploadsService);
    storage = module.get(StorageService, { strict: false });
    dataSource = module.get(DataSource);
    videoRepository = module.get(getRepositoryToken(Video));
    queue = module.get<Queue<ProcessVideoJobData>>(
      getQueueToken(VIDEO_PROCESSING_QUEUE),
      { strict: false },
    );
    closeModule = () => module.close();
  });

  async function abortOpenUploads(): Promise<void> {
    const open = await dataSource.query<
      { storage_key: string; upload_id: string }[]
    >(
      `SELECT storage_key, upload_id FROM "videos" WHERE upload_id IS NOT NULL`,
    );
    for (const { storage_key, upload_id } of open) {
      await storage.abortMultipartUpload(storage_key, upload_id);
    }
  }

  beforeEach(async () => {
    jest.restoreAllMocks();
    await abortOpenUploads();
    await cleanAllTables(dataSource);
    await queue.obliterate({ force: true });
  });

  afterAll(async () => {
    await abortOpenUploads();
    await storage.deletePrefix('videos/');
    await queue.obliterate({ force: true });
    await closeModule();
  });

  let counter = 0;
  async function createUserWithChannel(): Promise<Channel> {
    counter += 1;
    const user = await dataSource.getRepository(User).save(
      dataSource.getRepository(User).create({
        email: `uploader_${counter}@example.com`,
        password: 'hashed',
      }),
    );
    return dataSource.getRepository(Channel).save(
      dataSource.getRepository(Channel).create({
        name: `Uploader ${counter}`,
        nickname: `uploader_${counter}`,
        user_id: user.id,
      }),
    );
  }

  const body = {
    filename: 'aula.mp4',
    mime_type: 'video/mp4',
    size_bytes: 314572800,
  };

  it('should persist the draft with its multipart upload open in the storage', async () => {
    const channel = await createUserWithChannel();

    const { video, upload } = await service.initiate(channel.user_id, body);

    const row = await videoRepository.findOneByOrFail({
      public_id: video.id,
    });
    expect(row).toMatchObject({
      status: VideoStatus.DRAFT,
      channel_id: channel.id,
      title: 'aula',
      original_filename: 'aula.mp4',
      mime_type: 'video/mp4',
      size_bytes: '314572800',
      storage_key: `videos/${row.id}/original`,
      part_size_bytes: 104857600,
      part_count: 3,
      thumbnail_key: null,
    });
    expect(row.upload_id).toEqual(expect.any(String));
    expect(upload).toEqual({ part_size_bytes: 104857600, part_count: 3 });
    expect(video.size_bytes).toBe(314572800);
    await expect(
      storage.listParts(row.storage_key, row.upload_id as string),
    ).resolves.toEqual([]);
  });

  it('should attach the video to the channel of the requesting user only', async () => {
    const first = await createUserWithChannel();
    const second = await createUserWithChannel();

    const { video } = await service.initiate(second.user_id, body);

    const row = await videoRepository.findOneByOrFail({ public_id: video.id });
    expect(row.channel_id).toBe(second.id);
    expect(row.channel_id).not.toBe(first.id);
  });

  it('should recover from a real public_id collision with the unique constraint', async () => {
    const channel = await createUserWithChannel();
    const taken = await service.initiate(channel.user_id, body);
    const createUpload = jest.spyOn(storage, 'createMultipartUpload');
    jest
      .spyOn(publicIdUtil, 'generatePublicId')
      .mockReturnValueOnce(taken.video.id)
      .mockReturnValueOnce('ZZZZZZZZZZZ');

    const { video } = await service.initiate(channel.user_id, body);

    expect(video.id).toBe('ZZZZZZZZZZZ');
    expect(createUpload).toHaveBeenCalledTimes(1);
    expect(await videoRepository.count()).toBe(2);
  });

  it('should abort the storage upload when the draft cannot be persisted', async () => {
    const channel = await createUserWithChannel();
    const createUpload = jest.spyOn(storage, 'createMultipartUpload');
    jest
      .spyOn(videoRepository, 'save')
      .mockRejectedValueOnce(new Error('connection lost'));

    await expect(service.initiate(channel.user_id, body)).rejects.toThrow(
      'connection lost',
    );

    const [key] = createUpload.mock.calls[0];
    const uploadId = await (createUpload.mock.results[0]
      .value as Promise<string>);
    await expect(storage.listParts(key, uploadId)).rejects.toBeInstanceOf(
      StorageUploadNotFoundError,
    );
    expect(await videoRepository.count()).toBe(0);
  });

  it('should leave no draft and no upload for a user without a channel', async () => {
    const orphan = await dataSource.getRepository(User).save(
      dataSource.getRepository(User).create({
        email: 'no_channel@example.com',
        password: 'hashed',
      }),
    );
    const createUpload = jest.spyOn(storage, 'createMultipartUpload');

    await expect(service.initiate(orphan.id, body)).rejects.toThrow(
      /No channel found/,
    );

    expect(createUpload).not.toHaveBeenCalled();
    expect(await videoRepository.count()).toBe(0);
  });

  describe('signParts / listUploadedParts', () => {
    async function startUpload(): Promise<{
      channel: Channel;
      publicId: string;
    }> {
      const channel = await createUserWithChannel();
      const { video } = await service.initiate(channel.user_id, body);
      return { channel, publicId: video.id };
    }

    it('should sign urls the storage accepts and then list the stored part', async () => {
      const { channel, publicId } = await startUpload();

      const signed = await service.signParts(channel.user_id, publicId, {
        part_numbers: [1, 2],
      });
      const put = await fetch(signed.parts[0].url, {
        method: 'PUT',
        body: new Uint8Array(1024).fill(1),
      });
      const etag = put.headers.get('etag');

      expect(signed.parts.map((p) => p.part_number)).toEqual([1, 2]);
      expect(Date.parse(signed.expires_at)).toBeGreaterThan(Date.now());
      expect(put.status).toBe(200);
      expect(etag).toBeTruthy();
      await expect(
        service.listUploadedParts(channel.user_id, publicId),
      ).resolves.toEqual({
        part_size_bytes: 104857600,
        part_count: 3,
        uploaded_parts: [{ part_number: 1, etag, size_bytes: 1024 }],
      });
    });

    it('should list nothing before any part is sent', async () => {
      const { channel, publicId } = await startUpload();

      const result = await service.listUploadedParts(channel.user_id, publicId);

      expect(result.uploaded_parts).toEqual([]);
    });

    it('should refuse part numbers above part_count', async () => {
      const { channel, publicId } = await startUpload();

      await expect(
        service.signParts(channel.user_id, publicId, { part_numbers: [4] }),
      ).rejects.toBeInstanceOf(InvalidPartNumberException);
    });

    it('should hide the video from another user', async () => {
      const { publicId } = await startUpload();
      const stranger = await createUserWithChannel();

      await expect(
        service.listUploadedParts(stranger.user_id, publicId),
      ).rejects.toBeInstanceOf(VideoNotFoundException);
      await expect(
        service.signParts(stranger.user_id, publicId, { part_numbers: [1] }),
      ).rejects.toBeInstanceOf(VideoNotFoundException);
    });

    it('should refuse a video that already left draft', async () => {
      const { channel, publicId } = await startUpload();
      await videoRepository.update(
        { public_id: publicId },
        { status: VideoStatus.PROCESSING },
      );

      await expect(
        service.listUploadedParts(channel.user_id, publicId),
      ).rejects.toBeInstanceOf(InvalidUploadStateException);
    });

    it.each(['listUploadedParts', 'signParts'] as const)(
      'should fail the video as UPLOAD_EXPIRED when %s finds the multipart upload aborted',
      async (operation) => {
        const { channel, publicId } = await startUpload();
        const row = await videoRepository.findOneByOrFail({
          public_id: publicId,
        });
        await storage.abortMultipartUpload(
          row.storage_key,
          row.upload_id as string,
        );

        const attempt =
          operation === 'signParts'
            ? service.signParts(channel.user_id, publicId, {
                part_numbers: [1],
              })
            : service.listUploadedParts(channel.user_id, publicId);

        await expect(attempt).rejects.toBeInstanceOf(UploadExpiredException);
        const after = await videoRepository.findOneByOrFail({
          public_id: publicId,
        });
        expect(after).toMatchObject({
          status: VideoStatus.FAILED,
          failure_reason: 'UPLOAD_EXPIRED',
          upload_id: null,
        });
        await expect(
          service.listUploadedParts(channel.user_id, publicId),
        ).rejects.toBeInstanceOf(InvalidUploadStateException);
      },
    );
  });

  describe('complete', () => {
    // Two real 5 MiB parts (the S3 minimum for every part but the last).
    const FIVE_MIB = 5 * 1024 * 1024;

    async function startAndUpload(sizes: number[]): Promise<{
      channel: Channel;
      publicId: string;
      row: Video;
      parts: { part_number: number; etag: string }[];
    }> {
      const channel = await createUserWithChannel();
      const total = sizes.reduce((sum, size) => sum + size, 0);
      const { video } = await service.initiate(channel.user_id, {
        ...body,
        size_bytes: total,
      });
      // The default 100 MiB part size would make the test upload huge parts,
      // so the geometry is bent to the real parts being sent.
      await videoRepository.update(
        { public_id: video.id },
        { part_count: sizes.length },
      );
      const signed = await service.signParts(channel.user_id, video.id, {
        part_numbers: sizes.map((_, index) => index + 1),
      });
      const parts: { part_number: number; etag: string }[] = [];
      for (const [index, size] of sizes.entries()) {
        const put = await fetch(signed.parts[index].url, {
          method: 'PUT',
          body: new Uint8Array(size).fill(1),
        });
        parts.push({
          part_number: index + 1,
          etag: put.headers.get('etag') as string,
        });
      }
      const row = await videoRepository.findOneByOrFail({
        public_id: video.id,
      });
      return { channel, publicId: video.id, row, parts };
    }

    it('should assemble two real parts, mark the video processing and leave one process-video job', async () => {
      const { channel, publicId, row, parts } = await startAndUpload([
        FIVE_MIB,
        1024,
      ]);

      const result = await service.complete(channel.user_id, publicId, {
        parts,
      });

      expect(result).toMatchObject({
        id: publicId,
        status: 'processing',
        size_bytes: FIVE_MIB + 1024,
      });
      const after = await videoRepository.findOneByOrFail({ id: row.id });
      expect(after).toMatchObject({
        status: VideoStatus.PROCESSING,
        upload_id: null,
        size_bytes: String(FIVE_MIB + 1024),
      });
      await expect(storage.headObject(row.storage_key)).resolves.toMatchObject({
        contentLength: FIVE_MIB + 1024,
      });
      const job = await queue.getJob(row.id);
      expect(job?.name).toBe('process-video');
      expect(job?.data).toEqual({ videoId: row.id });
    });

    it('should not duplicate the job when called again', async () => {
      const { channel, publicId, row, parts } = await startAndUpload([1024]);

      await service.complete(channel.user_id, publicId, { parts });
      const again = await service.complete(channel.user_id, publicId, {
        parts,
      });

      expect(again.status).toBe('processing');
      const jobs = await queue.getJobs(['waiting', 'delayed', 'active']);
      expect(jobs.filter((job) => job.id === row.id)).toHaveLength(1);
    });

    it('should re-enqueue a processing video whose job was lost', async () => {
      const { channel, publicId, row, parts } = await startAndUpload([1024]);
      await service.complete(channel.user_id, publicId, { parts });
      await queue.obliterate({ force: true });

      await service.complete(channel.user_id, publicId, { parts });

      await expect(queue.getJob(row.id)).resolves.toBeDefined();
    });

    it('should reject a wrong ETag and keep the draft so the correct one still works', async () => {
      const { channel, publicId, row, parts } = await startAndUpload([1024]);

      await expect(
        service.complete(channel.user_id, publicId, {
          parts: [{ part_number: 1, etag: '"' + '0'.repeat(32) + '"' }],
        }),
      ).rejects.toBeInstanceOf(InvalidUploadPartsException);

      const draft = await videoRepository.findOneByOrFail({ id: row.id });
      expect(draft).toMatchObject({
        status: VideoStatus.DRAFT,
        upload_id: row.upload_id,
      });
      await expect(
        service.complete(channel.user_id, publicId, { parts }),
      ).resolves.toMatchObject({ status: 'processing' });
    });

    it('should fail the video as UPLOAD_EXPIRED when the multipart upload is gone', async () => {
      const { channel, publicId, row, parts } = await startAndUpload([1024]);
      await storage.abortMultipartUpload(
        row.storage_key,
        row.upload_id as string,
      );

      await expect(
        service.complete(channel.user_id, publicId, { parts }),
      ).rejects.toBeInstanceOf(UploadExpiredException);

      const after = await videoRepository.findOneByOrFail({ id: row.id });
      expect(after).toMatchObject({
        status: VideoStatus.FAILED,
        failure_reason: 'UPLOAD_EXPIRED',
        upload_id: null,
      });
      await expect(queue.getJob(row.id)).resolves.toBeUndefined();
    });

    it('should hide the video from another user', async () => {
      const { publicId, parts } = await startAndUpload([1024]);
      const stranger = await createUserWithChannel();

      await expect(
        service.complete(stranger.user_id, publicId, { parts }),
      ).rejects.toBeInstanceOf(VideoNotFoundException);
    });
  });

  describe('restart', () => {
    it('should reopen an expired upload on the same video with a multipart upload that accepts parts', async () => {
      const channel = await createUserWithChannel();
      const { video } = await service.initiate(channel.user_id, body);
      const first = await videoRepository.findOneByOrFail({
        public_id: video.id,
      });
      await storage.abortMultipartUpload(
        first.storage_key,
        first.upload_id as string,
      );
      await expect(
        service.listUploadedParts(channel.user_id, video.id),
      ).rejects.toBeInstanceOf(UploadExpiredException);

      const restarted = await service.restart(channel.user_id, video.id, {
        size_bytes: 209715200,
      });

      expect(restarted.video).toMatchObject({
        id: video.id,
        status: 'draft',
        failure_reason: null,
        size_bytes: 209715200,
      });
      expect(restarted.upload).toEqual({
        part_size_bytes: 104857600,
        part_count: 2,
      });
      const row = await videoRepository.findOneByOrFail({ id: first.id });
      expect(row.upload_id).toEqual(expect.any(String));
      expect(row.upload_id).not.toBe(first.upload_id);
      expect(row.storage_key).toBe(first.storage_key);
      const signed = await service.signParts(channel.user_id, video.id, {
        part_numbers: [1],
      });
      const put = await fetch(signed.parts[0].url, {
        method: 'PUT',
        body: new Uint8Array(1024).fill(1),
      });
      expect(put.status).toBe(200);
      const listed = await service.listUploadedParts(channel.user_id, video.id);
      expect(listed.uploaded_parts.map((p) => p.part_number)).toEqual([1]);
    });

    it('should refuse a draft video and leave its open upload alone', async () => {
      const channel = await createUserWithChannel();
      const { video } = await service.initiate(channel.user_id, body);
      const before = await videoRepository.findOneByOrFail({
        public_id: video.id,
      });

      await expect(
        service.restart(channel.user_id, video.id, {}),
      ).rejects.toBeInstanceOf(InvalidUploadStateException);

      const after = await videoRepository.findOneByOrFail({ id: before.id });
      expect(after.upload_id).toBe(before.upload_id);
    });
  });
});
