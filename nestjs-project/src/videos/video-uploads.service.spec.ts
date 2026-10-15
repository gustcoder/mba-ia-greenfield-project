import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { QueryFailedError } from 'typeorm';
import { ChannelsService } from '../channels/channels.service';
import videosConfig from '../config/videos.config';
import { StorageService } from '../storage/storage.service';
import { Video } from './entities/video.entity';
import { VideoStatus } from './entities/video-status.enum';
import {
  InvalidPartNumberException,
  InvalidUploadPartsException,
  InvalidUploadStateException,
  UnsupportedVideoTypeException,
  UploadExpiredException,
  VideoNotFoundException,
  VideoTooLargeException,
} from './exceptions/video.exceptions';
import {
  StorageInvalidPartsError,
  StorageUploadNotFoundError,
} from '../storage/storage.errors';
import { VideoProcessingQueue } from './processing/video-processing.queue';
import * as publicIdUtil from './public-id.util';
import { VideoResponseMapper } from './video-response.mapper';
import { VideoUploadsService } from './video-uploads.service';
import { VideosService } from './videos.service';

const USER_ID = 'user-1';
const CHANNEL_ID = 'channel-1';
const MAX_SIZE = 10737418240;
const PART_SIZE = 104857600;

const publicIdCollision = (): QueryFailedError =>
  new QueryFailedError(
    'INSERT',
    [],
    Object.assign(new Error('duplicate'), {
      code: '23505',
      detail: 'Key (public_id)=(abc) already exists.',
    }),
  );

describe('VideoUploadsService.initiate', () => {
  const repository = { create: jest.fn(), save: jest.fn() };
  const channels = { findByUserId: jest.fn() };
  const storage = {
    createMultipartUpload: jest.fn(),
    abortMultipartUpload: jest.fn(),
  };
  const mapper = { toVideoResponse: jest.fn() };
  let service: VideoUploadsService;

  const dto = (overrides: Record<string, unknown> = {}) => ({
    filename: 'aula.mp4',
    mime_type: 'video/mp4',
    size_bytes: 314572800,
    ...overrides,
  });

  beforeEach(async () => {
    jest.restoreAllMocks();
    repository.create.mockReset().mockImplementation((v: object) => ({
      ...v,
      status: VideoStatus.DRAFT,
    }));
    repository.save.mockReset().mockImplementation((v: object) =>
      Promise.resolve({
        ...v,
        created_at: new Date(),
        updated_at: new Date(),
      }),
    );
    channels.findByUserId.mockReset().mockResolvedValue({ id: CHANNEL_ID });
    storage.createMultipartUpload.mockReset().mockResolvedValue('upload-1');
    storage.abortMultipartUpload.mockReset().mockResolvedValue(undefined);
    mapper.toVideoResponse
      .mockReset()
      .mockImplementation((v: Video) => Promise.resolve({ id: v.public_id }));

    const module = await Test.createTestingModule({
      providers: [
        VideoUploadsService,
        { provide: getRepositoryToken(Video), useValue: repository },
        { provide: ChannelsService, useValue: channels },
        {
          provide: VideosService,
          useValue: { findOwnedByPublicId: jest.fn() },
        },
        { provide: StorageService, useValue: storage },
        { provide: VideoResponseMapper, useValue: mapper },
        { provide: VideoProcessingQueue, useValue: {} },
        {
          provide: videosConfig.KEY,
          useValue: {
            maxSizeBytes: MAX_SIZE,
            uploadPartSizeBytes: PART_SIZE,
          },
        },
      ],
    }).compile();
    service = module.get(VideoUploadsService);
  });

  it('should open the multipart for the original key and persist the draft with its upload id', async () => {
    const result = await service.initiate(USER_ID, dto());

    const [key, contentType] = storage.createMultipartUpload.mock.calls[0] as [
      string,
      string,
    ];
    expect(key).toMatch(/^videos\/[0-9a-f-]{36}\/original$/);
    expect(contentType).toBe('video/mp4');
    expect(repository.create).toHaveBeenCalledWith(
      expect.objectContaining({
        channel_id: CHANNEL_ID,
        original_filename: 'aula.mp4',
        mime_type: 'video/mp4',
        size_bytes: '314572800',
        storage_key: key,
        upload_id: 'upload-1',
        part_size_bytes: PART_SIZE,
        part_count: 3,
      }),
    );
    expect(key).toContain((repository.create.mock.calls[0] as [Video])[0].id);
    expect(result.upload).toEqual({
      part_size_bytes: PART_SIZE,
      part_count: 3,
    });
  });

  it('should default the title to the file name without extension', async () => {
    await service.initiate(USER_ID, dto({ filename: 'Minha Aula.mov' }));

    expect(repository.create).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Minha Aula' }),
    );
  });

  it('should truncate a long default title to 100 characters', async () => {
    await service.initiate(
      USER_ID,
      dto({ filename: `${'x'.repeat(200)}.mp4` }),
    );

    expect(repository.create).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'x'.repeat(100) }),
    );
  });

  it('should keep a title given by the client', async () => {
    await service.initiate(USER_ID, dto({ title: 'Aula 1' }));

    expect(repository.create).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Aula 1' }),
    );
  });

  it.each([
    [1, 1],
    [PART_SIZE, 1],
    [PART_SIZE + 1, 2],
    [MAX_SIZE, 103],
  ])(
    'should compute part_count for %i bytes as %i (rounded up)',
    async (size, parts) => {
      const { upload } = await service.initiate(
        USER_ID,
        dto({ size_bytes: size }),
      );

      expect(upload.part_count).toBe(parts);
    },
  );

  it('should reject a MIME type outside the allowlist before touching storage or the database', async () => {
    await expect(
      service.initiate(USER_ID, dto({ mime_type: 'image/png' })),
    ).rejects.toBeInstanceOf(UnsupportedVideoTypeException);

    expect(storage.createMultipartUpload).not.toHaveBeenCalled();
    expect(repository.save).not.toHaveBeenCalled();
  });

  it.each(['video/mp4', 'video/quicktime', 'video/webm', 'video/x-matroska'])(
    'should accept %s',
    async (mime) => {
      await expect(
        service.initiate(USER_ID, dto({ mime_type: mime })),
      ).resolves.toBeDefined();
    },
  );

  it('should reject a size above the limit but accept exactly the limit', async () => {
    await expect(
      service.initiate(USER_ID, dto({ size_bytes: MAX_SIZE + 1 })),
    ).rejects.toBeInstanceOf(VideoTooLargeException);
    expect(storage.createMultipartUpload).not.toHaveBeenCalled();

    await expect(
      service.initiate(USER_ID, dto({ size_bytes: MAX_SIZE })),
    ).resolves.toBeDefined();
  });

  it('should re-roll the public id on a collision and open the multipart only once', async () => {
    repository.save
      .mockRejectedValueOnce(publicIdCollision())
      .mockRejectedValueOnce(publicIdCollision());
    const generate = jest
      .spyOn(publicIdUtil, 'generatePublicId')
      .mockReturnValueOnce('AAAAAAAAAAA')
      .mockReturnValueOnce('BBBBBBBBBBB')
      .mockReturnValueOnce('CCCCCCCCCCC');

    const result = await service.initiate(USER_ID, dto());

    expect(generate).toHaveBeenCalledTimes(3);
    expect(repository.save).toHaveBeenCalledTimes(3);
    expect(result.video).toEqual({ id: 'CCCCCCCCCCC' });
    expect(storage.createMultipartUpload).toHaveBeenCalledTimes(1);
    expect(storage.abortMultipartUpload).not.toHaveBeenCalled();
  });

  it('should give up after repeated collisions and abort the multipart upload', async () => {
    repository.save.mockRejectedValue(publicIdCollision());

    await expect(service.initiate(USER_ID, dto())).rejects.toBeInstanceOf(
      QueryFailedError,
    );

    expect(repository.save).toHaveBeenCalledTimes(5);
    expect(storage.abortMultipartUpload).toHaveBeenCalledTimes(1);
  });

  it('should abort the multipart upload and rethrow when persisting fails', async () => {
    const failure = new Error('connection lost');
    repository.save.mockRejectedValueOnce(failure);

    await expect(service.initiate(USER_ID, dto())).rejects.toBe(failure);

    const [key] = storage.createMultipartUpload.mock.calls[0] as [string];
    expect(storage.abortMultipartUpload).toHaveBeenCalledWith(key, 'upload-1');
    expect(repository.save).toHaveBeenCalledTimes(1);
  });

  it('should still surface the persistence error when the abort also fails', async () => {
    const failure = new Error('connection lost');
    repository.save.mockRejectedValueOnce(failure);
    storage.abortMultipartUpload.mockRejectedValueOnce(new Error('s3 down'));

    await expect(service.initiate(USER_ID, dto())).rejects.toBe(failure);
  });

  it('should not open any upload when the storage cannot create one', async () => {
    storage.createMultipartUpload.mockRejectedValueOnce(new Error('s3 down'));

    await expect(service.initiate(USER_ID, dto())).rejects.toThrow('s3 down');

    expect(repository.save).not.toHaveBeenCalled();
    expect(storage.abortMultipartUpload).not.toHaveBeenCalled();
  });

  it('should fail loudly when the user has no channel, without opening an upload', async () => {
    channels.findByUserId.mockResolvedValueOnce(null);

    await expect(service.initiate(USER_ID, dto())).rejects.toThrow(
      /No channel found/,
    );

    expect(storage.createMultipartUpload).not.toHaveBeenCalled();
  });
});

describe('VideoUploadsService — signParts / listUploadedParts', () => {
  const PUBLIC_ID = 'dQw4w9WgXcQ';
  const repository = { update: jest.fn() };
  const videos = { findOwnedByPublicId: jest.fn() };
  const storage = {
    listParts: jest.fn(),
    presignUploadPart: jest.fn(),
  };
  let service: VideoUploadsService;

  const draft = (overrides: Partial<Video> = {}): Video =>
    ({
      id: 'video-uuid',
      public_id: PUBLIC_ID,
      status: VideoStatus.DRAFT,
      storage_key: 'videos/video-uuid/original',
      upload_id: 'upload-1',
      part_size_bytes: PART_SIZE,
      part_count: 3,
      ...overrides,
    }) as Video;

  beforeEach(async () => {
    jest.restoreAllMocks();
    repository.update.mockReset().mockResolvedValue(undefined);
    videos.findOwnedByPublicId.mockReset().mockResolvedValue(draft());
    storage.listParts.mockReset().mockResolvedValue([]);
    storage.presignUploadPart
      .mockReset()
      .mockImplementation((_k: string, _u: string, part: number) =>
        Promise.resolve(`https://signed.test/part-${part}`),
      );

    const module = await Test.createTestingModule({
      providers: [
        VideoUploadsService,
        { provide: getRepositoryToken(Video), useValue: repository },
        { provide: ChannelsService, useValue: {} },
        { provide: VideosService, useValue: videos },
        { provide: StorageService, useValue: storage },
        { provide: VideoResponseMapper, useValue: {} },
        { provide: VideoProcessingQueue, useValue: {} },
        {
          provide: videosConfig.KEY,
          useValue: { uploadUrlTtlSeconds: 900 },
        },
      ],
    }).compile();
    service = module.get(VideoUploadsService);
  });

  describe('signParts', () => {
    it('should sign each requested part with the upload TTL and report when the urls expire', async () => {
      jest
        .spyOn(Date, 'now')
        .mockReturnValue(Date.parse('2026-10-14T10:00:00Z'));

      const result = await service.signParts(USER_ID, PUBLIC_ID, {
        part_numbers: [1, 3],
      });

      expect(videos.findOwnedByPublicId).toHaveBeenCalledWith(
        USER_ID,
        PUBLIC_ID,
      );
      expect(storage.presignUploadPart).toHaveBeenCalledWith(
        'videos/video-uuid/original',
        'upload-1',
        1,
        900,
      );
      expect(storage.presignUploadPart).toHaveBeenCalledWith(
        'videos/video-uuid/original',
        'upload-1',
        3,
        900,
      );
      expect(result).toEqual({
        parts: [
          { part_number: 1, url: 'https://signed.test/part-1' },
          { part_number: 3, url: 'https://signed.test/part-3' },
        ],
        expires_at: '2026-10-14T10:15:00.000Z',
      });
    });

    it('should accept the last part number and reject the one after it, signing nothing', async () => {
      await expect(
        service.signParts(USER_ID, PUBLIC_ID, { part_numbers: [3] }),
      ).resolves.toBeDefined();
      storage.presignUploadPart.mockClear();

      await expect(
        service.signParts(USER_ID, PUBLIC_ID, { part_numbers: [1, 4] }),
      ).rejects.toBeInstanceOf(InvalidPartNumberException);

      expect(storage.presignUploadPart).not.toHaveBeenCalled();
    });

    it.each([VideoStatus.PROCESSING, VideoStatus.READY, VideoStatus.FAILED])(
      'should refuse a %s video without touching the storage',
      async (status) => {
        videos.findOwnedByPublicId.mockResolvedValue(
          draft({ status, upload_id: null }),
        );

        await expect(
          service.signParts(USER_ID, PUBLIC_ID, { part_numbers: [1] }),
        ).rejects.toBeInstanceOf(InvalidUploadStateException);

        expect(storage.listParts).not.toHaveBeenCalled();
        expect(storage.presignUploadPart).not.toHaveBeenCalled();
      },
    );

    it('should let VideoNotFoundException from the ownership check through', async () => {
      videos.findOwnedByPublicId.mockRejectedValue(
        new VideoNotFoundException(),
      );

      await expect(
        service.signParts(USER_ID, PUBLIC_ID, { part_numbers: [1] }),
      ).rejects.toBeInstanceOf(VideoNotFoundException);
    });

    it('should mark the video failed/UPLOAD_EXPIRED when the storage no longer has the upload', async () => {
      storage.listParts.mockRejectedValue(new StorageUploadNotFoundError());

      await expect(
        service.signParts(USER_ID, PUBLIC_ID, { part_numbers: [1] }),
      ).rejects.toBeInstanceOf(UploadExpiredException);

      expect(repository.update).toHaveBeenCalledWith(
        { id: 'video-uuid', status: VideoStatus.DRAFT },
        {
          status: VideoStatus.FAILED,
          failure_reason: 'UPLOAD_EXPIRED',
          upload_id: null,
        },
      );
      expect(storage.presignUploadPart).not.toHaveBeenCalled();
    });

    it('should not fail the video on an unrelated storage error', async () => {
      const failure = new Error('s3 unreachable');
      storage.listParts.mockRejectedValue(failure);

      await expect(
        service.signParts(USER_ID, PUBLIC_ID, { part_numbers: [1] }),
      ).rejects.toBe(failure);

      expect(repository.update).not.toHaveBeenCalled();
    });
  });

  describe('listUploadedParts', () => {
    it('should map the stored parts and echo the upload geometry', async () => {
      storage.listParts.mockResolvedValue([
        { partNumber: 1, etag: '"abc"', sizeBytes: PART_SIZE },
        { partNumber: 2, etag: '"def"', sizeBytes: 1024 },
      ]);

      const result = await service.listUploadedParts(USER_ID, PUBLIC_ID);

      expect(storage.listParts).toHaveBeenCalledWith(
        'videos/video-uuid/original',
        'upload-1',
      );
      expect(result).toEqual({
        part_size_bytes: PART_SIZE,
        part_count: 3,
        uploaded_parts: [
          { part_number: 1, etag: '"abc"', size_bytes: PART_SIZE },
          { part_number: 2, etag: '"def"', size_bytes: 1024 },
        ],
      });
    });

    it('should return an empty list when nothing was sent yet', async () => {
      const result = await service.listUploadedParts(USER_ID, PUBLIC_ID);

      expect(result.uploaded_parts).toEqual([]);
    });

    it.each([VideoStatus.PROCESSING, VideoStatus.READY, VideoStatus.FAILED])(
      'should refuse a %s video',
      async (status) => {
        videos.findOwnedByPublicId.mockResolvedValue(
          draft({ status, upload_id: null }),
        );

        await expect(
          service.listUploadedParts(USER_ID, PUBLIC_ID),
        ).rejects.toBeInstanceOf(InvalidUploadStateException);
        expect(storage.listParts).not.toHaveBeenCalled();
      },
    );

    it('should mark the video failed/UPLOAD_EXPIRED when the storage no longer has the upload', async () => {
      storage.listParts.mockRejectedValue(new StorageUploadNotFoundError());

      await expect(
        service.listUploadedParts(USER_ID, PUBLIC_ID),
      ).rejects.toBeInstanceOf(UploadExpiredException);

      expect(repository.update).toHaveBeenCalledWith(
        { id: 'video-uuid', status: VideoStatus.DRAFT },
        {
          status: VideoStatus.FAILED,
          failure_reason: 'UPLOAD_EXPIRED',
          upload_id: null,
        },
      );
    });

    it('should not fail the video on an unrelated storage error', async () => {
      const failure = new Error('s3 unreachable');
      storage.listParts.mockRejectedValue(failure);

      await expect(service.listUploadedParts(USER_ID, PUBLIC_ID)).rejects.toBe(
        failure,
      );

      expect(repository.update).not.toHaveBeenCalled();
    });
  });
});

describe('VideoUploadsService.complete', () => {
  const PUBLIC_ID = 'dQw4w9WgXcQ';
  const MAX = 1000;
  const repository = { update: jest.fn(), findOneByOrFail: jest.fn() };
  const videos = { findOwnedByPublicId: jest.fn() };
  const storage = {
    completeMultipartUpload: jest.fn(),
    headObject: jest.fn(),
    deletePrefix: jest.fn(),
  };
  const queue = { enqueue: jest.fn() };
  const mapper = { toVideoResponse: jest.fn() };
  const dto = { parts: [{ part_number: 1, etag: '"abc"' }] };
  let service: VideoUploadsService;

  const video = (overrides: Partial<Video> = {}): Video =>
    ({
      id: 'video-uuid',
      public_id: PUBLIC_ID,
      status: VideoStatus.DRAFT,
      storage_key: 'videos/video-uuid/original',
      upload_id: 'upload-1',
      ...overrides,
    }) as Video;

  beforeEach(async () => {
    jest.restoreAllMocks();
    repository.update.mockReset().mockResolvedValue(undefined);
    repository.findOneByOrFail
      .mockReset()
      .mockResolvedValue(video({ status: VideoStatus.PROCESSING }));
    videos.findOwnedByPublicId.mockReset().mockResolvedValue(video());
    storage.completeMultipartUpload.mockReset().mockResolvedValue(undefined);
    storage.headObject.mockReset().mockResolvedValue({ contentLength: 800 });
    storage.deletePrefix.mockReset().mockResolvedValue(undefined);
    queue.enqueue.mockReset().mockResolvedValue(undefined);
    mapper.toVideoResponse
      .mockReset()
      .mockImplementation((v: Video) =>
        Promise.resolve({ id: v.public_id, status: v.status }),
      );

    const module = await Test.createTestingModule({
      providers: [
        VideoUploadsService,
        { provide: getRepositoryToken(Video), useValue: repository },
        { provide: ChannelsService, useValue: {} },
        { provide: VideosService, useValue: videos },
        { provide: StorageService, useValue: storage },
        { provide: VideoResponseMapper, useValue: mapper },
        { provide: VideoProcessingQueue, useValue: queue },
        { provide: videosConfig.KEY, useValue: { maxSizeBytes: MAX } },
      ],
    }).compile();
    service = module.get(VideoUploadsService);
  });

  describe('draft', () => {
    it('should assemble the parts, save the confirmed size and enqueue the video', async () => {
      const result = await service.complete(USER_ID, PUBLIC_ID, dto);

      expect(storage.completeMultipartUpload).toHaveBeenCalledWith(
        'videos/video-uuid/original',
        'upload-1',
        [{ partNumber: 1, etag: '"abc"' }],
      );
      expect(repository.update).toHaveBeenCalledWith(
        { id: 'video-uuid' },
        {
          size_bytes: '800',
          upload_id: null,
          status: VideoStatus.PROCESSING,
        },
      );
      expect(queue.enqueue).toHaveBeenCalledWith('video-uuid');
      expect(result).toEqual({ id: PUBLIC_ID, status: VideoStatus.PROCESSING });
    });

    it('should enqueue only after the processing status is saved', async () => {
      const order: string[] = [];
      repository.update.mockImplementation(() => {
        order.push('update');
        return Promise.resolve();
      });
      queue.enqueue.mockImplementation(() => {
        order.push('enqueue');
        return Promise.resolve();
      });

      await service.complete(USER_ID, PUBLIC_ID, dto);

      expect(order).toEqual(['update', 'enqueue']);
    });

    it('should accept an object exactly at the size limit', async () => {
      storage.headObject.mockResolvedValue({ contentLength: MAX });

      await service.complete(USER_ID, PUBLIC_ID, dto);

      expect(queue.enqueue).toHaveBeenCalledTimes(1);
    });

    it('should fail the video as FILE_TOO_LARGE, delete its objects and not enqueue when the assembled object is above the limit', async () => {
      storage.headObject.mockResolvedValue({ contentLength: MAX + 1 });

      await expect(
        service.complete(USER_ID, PUBLIC_ID, dto),
      ).rejects.toBeInstanceOf(VideoTooLargeException);

      expect(storage.deletePrefix).toHaveBeenCalledWith('videos/video-uuid/');
      expect(repository.update).toHaveBeenCalledWith(
        { id: 'video-uuid' },
        {
          status: VideoStatus.FAILED,
          failure_reason: 'FILE_TOO_LARGE',
          upload_id: null,
        },
      );
      expect(queue.enqueue).not.toHaveBeenCalled();
    });

    it('should map rejected parts to INVALID_UPLOAD_PARTS and leave the draft untouched', async () => {
      storage.completeMultipartUpload.mockRejectedValue(
        new StorageInvalidPartsError(),
      );

      await expect(
        service.complete(USER_ID, PUBLIC_ID, dto),
      ).rejects.toBeInstanceOf(InvalidUploadPartsException);

      expect(repository.update).not.toHaveBeenCalled();
      expect(queue.enqueue).not.toHaveBeenCalled();
    });

    it('should fail the video as UPLOAD_EXPIRED (only if still a draft) when the storage lost the upload', async () => {
      storage.completeMultipartUpload.mockRejectedValue(
        new StorageUploadNotFoundError(),
      );

      await expect(
        service.complete(USER_ID, PUBLIC_ID, dto),
      ).rejects.toBeInstanceOf(UploadExpiredException);

      expect(repository.update).toHaveBeenCalledWith(
        { id: 'video-uuid', status: VideoStatus.DRAFT },
        {
          status: VideoStatus.FAILED,
          failure_reason: 'UPLOAD_EXPIRED',
          upload_id: null,
        },
      );
      expect(storage.headObject).not.toHaveBeenCalled();
      expect(queue.enqueue).not.toHaveBeenCalled();
    });

    it('should not fail the video on an unrelated storage error', async () => {
      storage.completeMultipartUpload.mockRejectedValue(new Error('boom'));

      await expect(service.complete(USER_ID, PUBLIC_ID, dto)).rejects.toThrow(
        'boom',
      );

      expect(repository.update).not.toHaveBeenCalled();
    });

    it('should refuse a draft that has no open upload', async () => {
      videos.findOwnedByPublicId.mockResolvedValue(video({ upload_id: null }));

      await expect(
        service.complete(USER_ID, PUBLIC_ID, dto),
      ).rejects.toBeInstanceOf(InvalidUploadStateException);

      expect(storage.completeMultipartUpload).not.toHaveBeenCalled();
    });

    it('should surface the enqueue failure after the status was saved, so a retry can re-enqueue', async () => {
      queue.enqueue.mockRejectedValue(new Error('redis down'));

      await expect(service.complete(USER_ID, PUBLIC_ID, dto)).rejects.toThrow(
        'redis down',
      );

      expect(repository.update).toHaveBeenCalledWith(
        { id: 'video-uuid' },
        expect.objectContaining({ status: VideoStatus.PROCESSING }),
      );
    });
  });

  describe('video that already left draft', () => {
    it('should re-enqueue a processing video without touching the storage or the row', async () => {
      videos.findOwnedByPublicId.mockResolvedValue(
        video({ status: VideoStatus.PROCESSING, upload_id: null }),
      );

      const result = await service.complete(USER_ID, PUBLIC_ID, dto);

      expect(queue.enqueue).toHaveBeenCalledWith('video-uuid');
      expect(storage.completeMultipartUpload).not.toHaveBeenCalled();
      expect(repository.update).not.toHaveBeenCalled();
      expect(result).toEqual({ id: PUBLIC_ID, status: VideoStatus.PROCESSING });
    });

    it('should return a ready video without enqueuing', async () => {
      videos.findOwnedByPublicId.mockResolvedValue(
        video({ status: VideoStatus.READY, upload_id: null }),
      );

      const result = await service.complete(USER_ID, PUBLIC_ID, dto);

      expect(queue.enqueue).not.toHaveBeenCalled();
      expect(repository.update).not.toHaveBeenCalled();
      expect(result).toEqual({ id: PUBLIC_ID, status: VideoStatus.READY });
    });

    it('should refuse a failed video with INVALID_UPLOAD_STATE', async () => {
      videos.findOwnedByPublicId.mockResolvedValue(
        video({ status: VideoStatus.FAILED, upload_id: null }),
      );

      await expect(
        service.complete(USER_ID, PUBLIC_ID, dto),
      ).rejects.toBeInstanceOf(InvalidUploadStateException);

      expect(queue.enqueue).not.toHaveBeenCalled();
    });

    it('should let VideoNotFoundException from the ownership check through', async () => {
      videos.findOwnedByPublicId.mockRejectedValue(
        new VideoNotFoundException(),
      );

      await expect(
        service.complete(USER_ID, PUBLIC_ID, dto),
      ).rejects.toBeInstanceOf(VideoNotFoundException);
    });
  });
});

describe('VideoUploadsService.restart', () => {
  const PUBLIC_ID = 'dQw4w9WgXcQ';
  const MAX = 1000;
  const PART = 400;
  const repository = { update: jest.fn(), findOneByOrFail: jest.fn() };
  const videos = { findOwnedByPublicId: jest.fn() };
  const storage = {
    createMultipartUpload: jest.fn(),
    abortMultipartUpload: jest.fn(),
  };
  const mapper = { toVideoResponse: jest.fn() };
  let service: VideoUploadsService;

  const expired = (overrides: Partial<Video> = {}): Video =>
    ({
      id: 'video-uuid',
      public_id: PUBLIC_ID,
      status: VideoStatus.FAILED,
      failure_reason: 'UPLOAD_EXPIRED',
      mime_type: 'video/mp4',
      size_bytes: '900',
      storage_key: 'videos/video-uuid/original',
      upload_id: null,
      ...overrides,
    }) as Video;

  beforeEach(async () => {
    jest.restoreAllMocks();
    repository.update.mockReset().mockResolvedValue({ affected: 1 });
    repository.findOneByOrFail
      .mockReset()
      .mockResolvedValue(expired({ status: VideoStatus.DRAFT }));
    videos.findOwnedByPublicId.mockReset().mockResolvedValue(expired());
    storage.createMultipartUpload.mockReset().mockResolvedValue('upload-2');
    storage.abortMultipartUpload.mockReset().mockResolvedValue(undefined);
    mapper.toVideoResponse
      .mockReset()
      .mockImplementation((v: Video) =>
        Promise.resolve({ id: v.public_id, status: v.status }),
      );

    const module = await Test.createTestingModule({
      providers: [
        VideoUploadsService,
        { provide: getRepositoryToken(Video), useValue: repository },
        { provide: ChannelsService, useValue: {} },
        { provide: VideosService, useValue: videos },
        { provide: StorageService, useValue: storage },
        { provide: VideoResponseMapper, useValue: mapper },
        { provide: VideoProcessingQueue, useValue: {} },
        {
          provide: videosConfig.KEY,
          useValue: { maxSizeBytes: MAX, uploadPartSizeBytes: PART },
        },
      ],
    }).compile();
    service = module.get(VideoUploadsService);
  });

  it('should reopen a multipart upload on the same key and put the video back in draft', async () => {
    const result = await service.restart(USER_ID, PUBLIC_ID, {
      size_bytes: 900,
    });

    expect(storage.createMultipartUpload).toHaveBeenCalledWith(
      'videos/video-uuid/original',
      'video/mp4',
    );
    expect(repository.update).toHaveBeenCalledWith(
      {
        id: 'video-uuid',
        status: VideoStatus.FAILED,
        failure_reason: 'UPLOAD_EXPIRED',
      },
      {
        status: VideoStatus.DRAFT,
        failure_reason: null,
        upload_id: 'upload-2',
        size_bytes: '900',
        part_size_bytes: PART,
        part_count: 3,
      },
    );
    expect(result).toEqual({
      video: { id: PUBLIC_ID, status: VideoStatus.DRAFT },
      upload: { part_size_bytes: PART, part_count: 3 },
    });
  });

  it('should recompute part_count from the new size_bytes', async () => {
    const result = await service.restart(USER_ID, PUBLIC_ID, {
      size_bytes: 400,
    });

    expect(result.upload).toEqual({ part_size_bytes: PART, part_count: 1 });
    expect(repository.update).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ size_bytes: '400', part_count: 1 }),
    );
  });

  it('should keep the declared size when none is sent', async () => {
    const result = await service.restart(USER_ID, PUBLIC_ID, {});

    expect(result.upload.part_count).toBe(3);
    expect(repository.update).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ size_bytes: '900' }),
    );
  });

  it.each([
    ['failed for another reason', VideoStatus.FAILED, 'INVALID_MEDIA'],
    ['draft', VideoStatus.DRAFT, null],
    ['processing', VideoStatus.PROCESSING, null],
    ['ready', VideoStatus.READY, null],
  ])(
    'should refuse a video that is %s, opening nothing',
    async (_label, status, failureReason) => {
      videos.findOwnedByPublicId.mockResolvedValue(
        expired({ status, failure_reason: failureReason }),
      );

      await expect(
        service.restart(USER_ID, PUBLIC_ID, {}),
      ).rejects.toBeInstanceOf(InvalidUploadStateException);

      expect(storage.createMultipartUpload).not.toHaveBeenCalled();
      expect(repository.update).not.toHaveBeenCalled();
    },
  );

  it('should reject a size above the limit but accept exactly the limit', async () => {
    await expect(
      service.restart(USER_ID, PUBLIC_ID, { size_bytes: MAX + 1 }),
    ).rejects.toBeInstanceOf(VideoTooLargeException);
    expect(storage.createMultipartUpload).not.toHaveBeenCalled();

    await expect(
      service.restart(USER_ID, PUBLIC_ID, { size_bytes: MAX }),
    ).resolves.toBeDefined();
  });

  it('should abort the new multipart upload and rethrow when saving fails', async () => {
    repository.update.mockRejectedValue(new Error('db down'));

    await expect(service.restart(USER_ID, PUBLIC_ID, {})).rejects.toThrow(
      'db down',
    );

    expect(storage.abortMultipartUpload).toHaveBeenCalledWith(
      'videos/video-uuid/original',
      'upload-2',
    );
  });

  it('should abort the new multipart upload and refuse when a concurrent call already changed the video', async () => {
    repository.update.mockResolvedValue({ affected: 0 });

    await expect(
      service.restart(USER_ID, PUBLIC_ID, {}),
    ).rejects.toBeInstanceOf(InvalidUploadStateException);

    expect(storage.abortMultipartUpload).toHaveBeenCalledWith(
      'videos/video-uuid/original',
      'upload-2',
    );
  });

  it('should let VideoNotFoundException from the ownership check through', async () => {
    videos.findOwnedByPublicId.mockRejectedValue(new VideoNotFoundException());

    await expect(
      service.restart(USER_ID, PUBLIC_ID, {}),
    ).rejects.toBeInstanceOf(VideoNotFoundException);
  });
});
