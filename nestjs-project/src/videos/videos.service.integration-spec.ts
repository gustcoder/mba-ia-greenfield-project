import { randomUUID } from 'crypto';
import { Test } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { VerificationToken } from '../auth/entities/verification-token.entity';
import { Channel } from '../channels/entities/channel.entity';
import {
  cleanAllTables,
  createTestDataSource,
} from '../test/create-test-data-source';
import { User } from '../users/entities/user.entity';
import { Video } from './entities/video.entity';
import { VideoNotFoundException } from './exceptions/video.exceptions';
import { generatePublicId } from './public-id.util';
import { VideosService } from './videos.service';

const ALL_ENTITIES = [User, Channel, RefreshToken, VerificationToken, Video];

describe('VideosService.findOwnedByPublicId (Postgres)', () => {
  let service: VideosService;
  let dataSource: DataSource;
  let closeModule: () => Promise<void>;

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      imports: [
        TypeOrmModule.forRoot(createTestDataSource(ALL_ENTITIES).options),
        TypeOrmModule.forFeature([Video]),
      ],
      providers: [VideosService],
    }).compile();
    service = module.get(VideosService);
    dataSource = module.get(DataSource);
    closeModule = () => module.close();
  });

  afterAll(async () => {
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
});
