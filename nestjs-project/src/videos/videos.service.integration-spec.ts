import { randomUUID } from 'crypto';
import { Test } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { VerificationToken } from '../auth/entities/verification-token.entity';
import { Channel } from '../channels/entities/channel.entity';
import storageConfig from '../config/storage.config';
import videosConfig from '../config/videos.config';
import { StorageUploadNotFoundError } from '../storage/storage.errors';
import { StorageModule } from '../storage/storage.module';
import { StorageService } from '../storage/storage.service';
import {
  cleanAllTables,
  createTestDataSource,
} from '../test/create-test-data-source';
import { User } from '../users/entities/user.entity';
import { Video } from './entities/video.entity';
import { VideoStatus } from './entities/video-status.enum';
import {
  InvalidUploadStateException,
  VideoNotFoundException,
  VideoNotReadyException,
} from './exceptions/video.exceptions';
import { generatePublicId } from './public-id.util';
import { VideoResponseMapper } from './video-response.mapper';
import { VideosService } from './videos.service';

const ALL_ENTITIES = [User, Channel, RefreshToken, VerificationToken, Video];

describe('VideosService.findOwnedByPublicId (Postgres)', () => {
  let service: VideosService;
  let dataSource: DataSource;
  let storage: StorageService;
  let closeModule: () => Promise<void>;

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          load: [storageConfig, videosConfig],
        }),
        StorageModule,
        TypeOrmModule.forRoot(createTestDataSource(ALL_ENTITIES).options),
        TypeOrmModule.forFeature([Video]),
      ],
      providers: [VideosService, VideoResponseMapper],
    }).compile();
    service = module.get(VideosService);
    dataSource = module.get(DataSource);
    storage = module.get(StorageService);
    closeModule = () => module.close();
  });

  afterAll(async () => {
    await storage.deletePrefix('videos/');
    await closeModule();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
  });

  let counter = 0;
  async function createOwner(): Promise<{ user: User; channel: Channel }> {
    counter += 1;
    const users = dataSource.getRepository(User);
    const channels = dataSource.getRepository(Channel);
    const user = await users.save(
      users.create({ email: `owner_${counter}@example.com`, password: 'x' }),
    );
    const channel = await channels.save(
      channels.create({
        name: `Owner ${counter}`,
        nickname: `owner_${counter}`,
        user_id: user.id,
      }),
    );
    return { user, channel };
  }

  async function createVideo(channelId: string): Promise<Video> {
    const videos = dataSource.getRepository(Video);
    const id = randomUUID();
    return videos.save(
      videos.create({
        id,
        public_id: generatePublicId(),
        channel_id: channelId,
        title: 'aula',
        original_filename: 'aula.mp4',
        mime_type: 'video/mp4',
        size_bytes: '1024',
        storage_key: `videos/${id}/original`,
        part_size_bytes: 104857600,
        part_count: 1,
      }),
    );
  }

  it('should return the video to the user who owns its channel', async () => {
    const { user, channel } = await createOwner();
    const video = await createVideo(channel.id);

    const found = await service.findOwnedByPublicId(user.id, video.public_id);

    expect(found.id).toBe(video.id);
    expect(found.channel_id).toBe(channel.id);
  });

  it('should answer not found, identically, for another user, an unknown id and a malformed id', async () => {
    const owner = await createOwner();
    const stranger = await createOwner();
    const video = await createVideo(owner.channel.id);

    const attempts = [
      service.findOwnedByPublicId(stranger.user.id, video.public_id),
      service.findOwnedByPublicId(owner.user.id, 'AAAAAAAAAAA'),
      service.findOwnedByPublicId(owner.user.id, 'not-an-id!!'),
    ];

    const results = await Promise.allSettled(attempts);
    for (const result of results) {
      expect(result.status).toBe('rejected');
      const reason = (result as PromiseRejectedResult).reason as Error;
      expect(reason).toBeInstanceOf(VideoNotFoundException);
      expect(reason.message).toBe('Video not found');
    }
  });

  it('should resolve the right video among several of different channels', async () => {
    const first = await createOwner();
    const second = await createOwner();
    await createVideo(first.channel.id);
    const target = await createVideo(second.channel.id);

    const found = await service.findOwnedByPublicId(
      second.user.id,
      target.public_id,
    );

    expect(found.id).toBe(target.id);
  });

  describe('deleteOwned', () => {
    it('should abort the multipart, remove every object under the prefix and the row of a draft', async () => {
      const { user, channel } = await createOwner();
      const video = await createVideo(channel.id);
      const uploadId = await storage.createMultipartUpload(
        video.storage_key,
        'video/mp4',
      );
      await dataSource
        .getRepository(Video)
        .update({ id: video.id }, { upload_id: uploadId });
      await storage.putObject(
        `videos/${video.id}/thumbnail.jpg`,
        'x',
        'image/jpeg',
      );

      await service.deleteOwned(user.id, video.public_id);

      await expect(
        dataSource.getRepository(Video).findOneBy({ id: video.id }),
      ).resolves.toBeNull();
      await expect(
        storage.listParts(video.storage_key, uploadId),
      ).rejects.toBeInstanceOf(StorageUploadNotFoundError);
      await expect(
        storage.headObject(`videos/${video.id}/thumbnail.jpg`),
      ).rejects.toBeDefined();
    });

    it('should delete a failed video whose multipart upload is already gone', async () => {
      const { user, channel } = await createOwner();
      const video = await createVideo(channel.id);
      await dataSource.getRepository(Video).update(
        { id: video.id },
        {
          status: VideoStatus.FAILED,
          failure_reason: 'UPLOAD_EXPIRED',
          upload_id: 'gone-upload-id',
        },
      );

      await service.deleteOwned(user.id, video.public_id);

      await expect(
        dataSource.getRepository(Video).findOneBy({ id: video.id }),
      ).resolves.toBeNull();
    });

    it.each([VideoStatus.PROCESSING, VideoStatus.READY])(
      'should refuse a %s video and keep its row and object',
      async (status) => {
        const { user, channel } = await createOwner();
        const video = await createVideo(channel.id);
        await storage.putObject(video.storage_key, 'x', 'video/mp4');
        await dataSource
          .getRepository(Video)
          .update({ id: video.id }, { status });

        await expect(
          service.deleteOwned(user.id, video.public_id),
        ).rejects.toBeInstanceOf(InvalidUploadStateException);

        await expect(
          dataSource.getRepository(Video).findOneBy({ id: video.id }),
        ).resolves.not.toBeNull();
        await expect(
          storage.headObject(video.storage_key),
        ).resolves.toBeDefined();
      },
    );

    it("should answer not found for another user's video and keep it", async () => {
      const owner = await createOwner();
      const stranger = await createOwner();
      const video = await createVideo(owner.channel.id);

      await expect(
        service.deleteOwned(stranger.user.id, video.public_id),
      ).rejects.toBeInstanceOf(VideoNotFoundException);

      await expect(
        dataSource.getRepository(Video).findOneBy({ id: video.id }),
      ).resolves.not.toBeNull();
    });
  });

  describe('detail, stream and download (real storage)', () => {
    const THUMB = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);

    async function createReadyVideo(
      withThumbnail: boolean,
    ): Promise<{ user: User; video: Video }> {
      const { user, channel } = await createOwner();
      const video = await createVideo(channel.id);
      await storage.putObject(
        video.storage_key,
        Buffer.alloc(4096, 7),
        'video/mp4',
      );
      const thumbnailKey = `videos/${video.id}/thumbnail.jpg`;
      if (withThumbnail) {
        await storage.putObject(thumbnailKey, THUMB, 'image/jpeg');
      }
      await dataSource.getRepository(Video).update(
        { id: video.id },
        {
          status: VideoStatus.READY,
          title: 'Minha Aula',
          original_filename: 'Minha Aula.mp4',
          thumbnail_key: withThumbnail ? thumbnailKey : null,
          duration_seconds: 12.5,
          width: 1280,
          height: 720,
          video_codec: 'h264',
        },
      );
      return { user, video };
    }

    it('should expose a thumbnail url only when the video has a thumbnail, and the url serves the image', async () => {
      const withThumbnail = await createReadyVideo(true);
      const without = await createReadyVideo(false);

      const detail = await service.getOwned(
        withThumbnail.user.id,
        withThumbnail.video.public_id,
      );
      const bare = await service.getOwned(
        without.user.id,
        without.video.public_id,
      );

      expect(detail).toMatchObject({
        status: 'ready',
        duration_seconds: 12.5,
        width: 1280,
        height: 720,
        video_codec: 'h264',
      });
      expect(detail.thumbnail_url).toEqual(expect.any(String));
      expect(bare.thumbnail_url).toBeNull();
      const image = await fetch(detail.thumbnail_url as string);
      expect(image.status).toBe(200);
      expect(Buffer.from(await image.arrayBuffer())).toEqual(THUMB);
    });

    it('should not expose internal fields in the detail', async () => {
      const { user, video } = await createReadyVideo(true);

      const detail = await service.getOwned(user.id, video.public_id);

      expect(Object.keys(detail)).not.toEqual(
        expect.arrayContaining(['uuid', 'storage_key', 'upload_id']),
      );
      // The internal id is part of the storage key, so it shows up inside the
      // presigned thumbnail url by design; nowhere else.
      const rest = Object.fromEntries(
        Object.entries(detail).filter(([key]) => key !== 'thumbnail_url'),
      );
      expect(JSON.stringify(rest)).not.toContain(video.id);
    });

    it('should return a stream url that answers a Range request with 206', async () => {
      const { user, video } = await createReadyVideo(false);

      const { url, expires_at } = await service.getStreamUrl(
        user.id,
        video.public_id,
      );

      expect(Date.parse(expires_at)).toBeGreaterThan(Date.now());
      const response = await fetch(url, { headers: { Range: 'bytes=0-1023' } });
      expect(response.status).toBe(206);
      expect(response.headers.get('content-range')).toBe('bytes 0-1023/4096');
      expect((await response.arrayBuffer()).byteLength).toBe(1024);
    });

    it('should return a download url that forces an attachment with the original file name', async () => {
      const { user, video } = await createReadyVideo(false);

      const { url } = await service.getDownloadUrl(user.id, video.public_id);

      const response = await fetch(url);
      expect(response.status).toBe(200);
      const disposition = response.headers.get('content-disposition') ?? '';
      expect(disposition).toContain('attachment');
      expect(disposition).toContain('filename="Minha Aula.mp4"');
    });

    it('should not turn the stream url into an attachment', async () => {
      const { user, video } = await createReadyVideo(false);

      const { url } = await service.getStreamUrl(user.id, video.public_id);

      const response = await fetch(url);
      expect(response.headers.get('content-disposition')).toBeNull();
    });

    it.each([VideoStatus.DRAFT, VideoStatus.PROCESSING, VideoStatus.FAILED])(
      'should refuse stream and download of a %s video',
      async (status) => {
        const { user, channel } = await createOwner();
        const video = await createVideo(channel.id);
        await dataSource
          .getRepository(Video)
          .update({ id: video.id }, { status });

        await expect(
          service.getStreamUrl(user.id, video.public_id),
        ).rejects.toBeInstanceOf(VideoNotReadyException);
        await expect(
          service.getDownloadUrl(user.id, video.public_id),
        ).rejects.toBeInstanceOf(VideoNotReadyException);
      },
    );

    it("should hide another user's video from all three operations", async () => {
      const { video } = await createReadyVideo(true);
      const stranger = await createOwner();

      for (const operation of [
        service.getOwned(stranger.user.id, video.public_id),
        service.getStreamUrl(stranger.user.id, video.public_id),
        service.getDownloadUrl(stranger.user.id, video.public_id),
      ]) {
        await expect(operation).rejects.toBeInstanceOf(VideoNotFoundException);
      }
    });
  });
});
