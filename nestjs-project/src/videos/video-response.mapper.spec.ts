import { Test } from '@nestjs/testing';
import videosConfig from '../config/videos.config';
import { StorageService } from '../storage/storage.service';
import { VideoStatus } from './entities/video-status.enum';
import { Video } from './entities/video.entity';
import { VideoResponseMapper } from './video-response.mapper';

describe('VideoResponseMapper', () => {
  const storage = { presignGet: jest.fn() };
  let mapper: VideoResponseMapper;

  const buildVideo = (overrides: Partial<Video> = {}): Video =>
    ({
      id: '0b0e8f1e-2f6c-4b8a-9a53-2f6a1d7c9e11',
      public_id: 'dQw4w9WgXcQ',
      channel_id: '7d1c4a52-0f0b-4e0b-8d36-1a2b3c4d5e6f',
      title: 'aula',
      status: VideoStatus.DRAFT,
      failure_reason: null,
      original_filename: 'aula.mp4',
      mime_type: 'video/mp4',
      size_bytes: '10737418240',
      storage_key: 'videos/0b0e8f1e/original',
      thumbnail_key: null,
      upload_id: 'secret-upload-id',
      part_size_bytes: 104857600,
      part_count: 103,
      duration_seconds: null,
      width: null,
      height: null,
      video_codec: null,
      metadata: null,
      created_at: new Date('2026-10-14T10:00:00.000Z'),
      updated_at: new Date('2026-10-14T11:00:00.000Z'),
      ...overrides,
    }) as Video;

  beforeEach(async () => {
    storage.presignGet.mockReset().mockResolvedValue('https://signed.test/t');
    const module = await Test.createTestingModule({
      providers: [
        VideoResponseMapper,
        { provide: StorageService, useValue: storage },
        {
          provide: videosConfig.KEY,
          useValue: { playbackUrlTtlSeconds: 1800 },
        },
      ],
    }).compile();
    mapper = module.get(VideoResponseMapper);
  });

  it('should expose the public id and convert the bigint size to a number', async () => {
    const dto = await mapper.toVideoResponse(buildVideo());

    expect(dto.id).toBe('dQw4w9WgXcQ');
    expect(dto.size_bytes).toBe(10737418240);
    expect(dto.created_at).toBe('2026-10-14T10:00:00.000Z');
    expect(dto.updated_at).toBe('2026-10-14T11:00:00.000Z');
  });

  it('should never expose internal fields', async () => {
    const dto = await mapper.toVideoResponse(buildVideo());

    expect(Object.keys(dto).sort()).toEqual(
      [
        'id',
        'title',
        'status',
        'failure_reason',
        'original_filename',
        'mime_type',
        'size_bytes',
        'duration_seconds',
        'width',
        'height',
        'video_codec',
        'thumbnail_url',
        'created_at',
        'updated_at',
      ].sort(),
    );
  });

  it('should leave thumbnail_url null and not sign anything without a thumbnail', async () => {
    const dto = await mapper.toVideoResponse(buildVideo());

    expect(dto.thumbnail_url).toBeNull();
    expect(storage.presignGet).not.toHaveBeenCalled();
  });

  it('should sign the thumbnail with the playback TTL when there is one', async () => {
    const dto = await mapper.toVideoResponse(
      buildVideo({ thumbnail_key: 'videos/x/thumbnail.jpg' }),
    );

    expect(dto.thumbnail_url).toBe('https://signed.test/t');
    expect(storage.presignGet).toHaveBeenCalledWith(
      'videos/x/thumbnail.jpg',
      1800,
    );
  });
});
