import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { StorageUploadNotFoundError } from '../storage/storage.errors';
import videosConfig from '../config/videos.config';
import { StorageService } from '../storage/storage.service';
import { VideoResponseMapper } from './video-response.mapper';
import { VideoStatus } from './entities/video-status.enum';
import {
  InvalidUploadStateException,
  VideoNotFoundException,
  VideoNotReadyException,
} from './exceptions/video.exceptions';
import { Video } from './entities/video.entity';
import { VideosService } from './videos.service';

describe('VideosService.findOwnedByPublicId', () => {
  const repository = { findOne: jest.fn() };
  let service: VideosService;

  beforeEach(async () => {
    repository.findOne.mockReset();
    const module = await Test.createTestingModule({
      providers: [
        VideosService,
        { provide: getRepositoryToken(Video), useValue: repository },
        { provide: StorageService, useValue: {} },
        { provide: VideoResponseMapper, useValue: {} },
        { provide: videosConfig.KEY, useValue: {} },
      ],
    }).compile();
    service = module.get(VideosService);
  });

  it.each([
    'short',
    'toolongtoolongtoolong',
    'invalid!!!!',
    '',
    'dQw4w9WgXc\n',
  ])(
    'should answer not found for the malformed id %p without querying the database',
    async (id) => {
      await expect(
        service.findOwnedByPublicId('user-1', id),
      ).rejects.toBeInstanceOf(VideoNotFoundException);

      expect(repository.findOne).not.toHaveBeenCalled();
    },
  );

  it('should look the video up by public id restricted to the owner user', async () => {
    const video = { id: 'uuid-1' } as Video;
    repository.findOne.mockResolvedValue(video);

    await expect(
      service.findOwnedByPublicId('user-1', 'dQw4w9WgXcQ'),
    ).resolves.toBe(video);

    expect(repository.findOne).toHaveBeenCalledWith({
      where: { public_id: 'dQw4w9WgXcQ', channel: { user_id: 'user-1' } },
    });
  });

  it('should answer not found when no row matches', async () => {
    repository.findOne.mockResolvedValue(null);

    await expect(
      service.findOwnedByPublicId('user-1', 'dQw4w9WgXcQ'),
    ).rejects.toBeInstanceOf(VideoNotFoundException);
  });
});

describe('VideosService.deleteOwned', () => {
  const repository = { findOne: jest.fn(), delete: jest.fn() };
  const storage = {
    abortMultipartUpload: jest.fn(),
    deletePrefix: jest.fn(),
  };
  let service: VideosService;

  const video = (overrides: Partial<Video> = {}): Video =>
    ({
      id: 'video-uuid',
      public_id: 'dQw4w9WgXcQ',
      status: VideoStatus.DRAFT,
      storage_key: 'videos/video-uuid/original',
      upload_id: 'upload-1',
      ...overrides,
    }) as Video;

  beforeEach(async () => {
    repository.findOne.mockReset().mockResolvedValue(video());
    repository.delete.mockReset().mockResolvedValue({ affected: 1 });
    storage.abortMultipartUpload.mockReset().mockResolvedValue(undefined);
    storage.deletePrefix.mockReset().mockResolvedValue(undefined);
    const module = await Test.createTestingModule({
      providers: [
        VideosService,
        { provide: getRepositoryToken(Video), useValue: repository },
        { provide: StorageService, useValue: storage },
        { provide: VideoResponseMapper, useValue: {} },
        { provide: videosConfig.KEY, useValue: {} },
      ],
    }).compile();
    service = module.get(VideosService);
  });

  it('should abort the multipart, delete the prefix and then the row of a draft', async () => {
    const order: string[] = [];
    storage.abortMultipartUpload.mockImplementation(() => {
      order.push('abort');
      return Promise.resolve();
    });
    storage.deletePrefix.mockImplementation(() => {
      order.push('prefix');
      return Promise.resolve();
    });
    repository.delete.mockImplementation(() => {
      order.push('row');
      return Promise.resolve({ affected: 1 });
    });

    await service.deleteOwned('user-1', 'dQw4w9WgXcQ');

    expect(storage.abortMultipartUpload).toHaveBeenCalledWith(
      'videos/video-uuid/original',
      'upload-1',
    );
    expect(storage.deletePrefix).toHaveBeenCalledWith('videos/video-uuid/');
    expect(repository.delete).toHaveBeenCalledWith({ id: 'video-uuid' });
    expect(order).toEqual(['abort', 'prefix', 'row']);
  });

  it('should not abort anything when the failed video has no open upload', async () => {
    repository.findOne.mockResolvedValue(
      video({ status: VideoStatus.FAILED, upload_id: null }),
    );

    await service.deleteOwned('user-1', 'dQw4w9WgXcQ');

    expect(storage.abortMultipartUpload).not.toHaveBeenCalled();
    expect(storage.deletePrefix).toHaveBeenCalledWith('videos/video-uuid/');
    expect(repository.delete).toHaveBeenCalledWith({ id: 'video-uuid' });
  });

  it('should still delete when the multipart upload no longer exists in the storage', async () => {
    storage.abortMultipartUpload.mockRejectedValue(
      new StorageUploadNotFoundError(),
    );

    await service.deleteOwned('user-1', 'dQw4w9WgXcQ');

    expect(storage.deletePrefix).toHaveBeenCalled();
    expect(repository.delete).toHaveBeenCalledWith({ id: 'video-uuid' });
  });

  it('should keep the row when the abort fails for another reason', async () => {
    storage.abortMultipartUpload.mockRejectedValue(new Error('storage down'));

    await expect(service.deleteOwned('user-1', 'dQw4w9WgXcQ')).rejects.toThrow(
      'storage down',
    );

    expect(storage.deletePrefix).not.toHaveBeenCalled();
    expect(repository.delete).not.toHaveBeenCalled();
  });

  it.each([VideoStatus.PROCESSING, VideoStatus.READY])(
    'should refuse a %s video and remove nothing',
    async (status) => {
      repository.findOne.mockResolvedValue(video({ status, upload_id: null }));

      await expect(
        service.deleteOwned('user-1', 'dQw4w9WgXcQ'),
      ).rejects.toBeInstanceOf(InvalidUploadStateException);

      expect(storage.deletePrefix).not.toHaveBeenCalled();
      expect(repository.delete).not.toHaveBeenCalled();
    },
  );
});

describe('VideosService — detail, stream and download', () => {
  const TTL = 900;
  const repository = { findOne: jest.fn() };
  const storage = { presignGet: jest.fn() };
  const mapper = { toVideoResponse: jest.fn() };
  let service: VideosService;

  const video = (overrides: Partial<Video> = {}): Video =>
    ({
      id: 'video-uuid',
      public_id: 'dQw4w9WgXcQ',
      status: VideoStatus.READY,
      storage_key: 'videos/video-uuid/original',
      original_filename: 'Minha Aula.mp4',
      ...overrides,
    }) as Video;

  beforeEach(async () => {
    repository.findOne.mockReset().mockResolvedValue(video());
    storage.presignGet.mockReset().mockResolvedValue('https://signed.test/x');
    mapper.toVideoResponse
      .mockReset()
      .mockImplementation((v: Video) =>
        Promise.resolve({ id: v.public_id, status: v.status }),
      );
    const module = await Test.createTestingModule({
      providers: [
        VideosService,
        { provide: getRepositoryToken(Video), useValue: repository },
        { provide: StorageService, useValue: storage },
        { provide: VideoResponseMapper, useValue: mapper },
        { provide: videosConfig.KEY, useValue: { playbackUrlTtlSeconds: TTL } },
      ],
    }).compile();
    service = module.get(VideosService);
  });

  describe('getOwned', () => {
    it.each(Object.values(VideoStatus))(
      'should return the %s video through the response mapper',
      async (status) => {
        repository.findOne.mockResolvedValue(video({ status }));

        await expect(
          service.getOwned('user-1', 'dQw4w9WgXcQ'),
        ).resolves.toEqual({ id: 'dQw4w9WgXcQ', status });
      },
    );

    it('should answer not found for a video of another user', async () => {
      repository.findOne.mockResolvedValue(null);

      await expect(
        service.getOwned('user-2', 'dQw4w9WgXcQ'),
      ).rejects.toBeInstanceOf(VideoNotFoundException);
      expect(mapper.toVideoResponse).not.toHaveBeenCalled();
    });
  });

  describe.each([['getStreamUrl' as const], ['getDownloadUrl' as const]])(
    '%s',
    (method) => {
      it('should sign the original with the playback TTL and report when it expires', async () => {
        const before = Date.now();

        const result = await service[method]('user-1', 'dQw4w9WgXcQ');

        expect(result.url).toBe('https://signed.test/x');
        expect(storage.presignGet).toHaveBeenCalledWith(
          'videos/video-uuid/original',
          TTL,
          expect.anything(),
        );
        const expiresAt = Date.parse(result.expires_at);
        expect(expiresAt).toBeGreaterThanOrEqual(before + TTL * 1000);
        expect(expiresAt).toBeLessThanOrEqual(Date.now() + TTL * 1000);
      });

      it.each([VideoStatus.DRAFT, VideoStatus.PROCESSING, VideoStatus.FAILED])(
        'should refuse a %s video with VIDEO_NOT_READY and sign nothing',
        async (status) => {
          repository.findOne.mockResolvedValue(video({ status }));

          await expect(
            service[method]('user-1', 'dQw4w9WgXcQ'),
          ).rejects.toBeInstanceOf(VideoNotReadyException);

          expect(storage.presignGet).not.toHaveBeenCalled();
        },
      );

      it('should answer not found for a video of another user', async () => {
        repository.findOne.mockResolvedValue(null);

        await expect(
          service[method]('user-2', 'dQw4w9WgXcQ'),
        ).rejects.toBeInstanceOf(VideoNotFoundException);
      });
    },
  );

  it('should ask for an attachment with the original file name only on download', async () => {
    await service.getStreamUrl('user-1', 'dQw4w9WgXcQ');
    await service.getDownloadUrl('user-1', 'dQw4w9WgXcQ');

    expect(storage.presignGet).toHaveBeenNthCalledWith(
      1,
      expect.anything(),
      TTL,
      { attachmentFilename: undefined },
    );
    expect(storage.presignGet).toHaveBeenNthCalledWith(
      2,
      expect.anything(),
      TTL,
      { attachmentFilename: 'Minha Aula.mp4' },
    );
  });
});
