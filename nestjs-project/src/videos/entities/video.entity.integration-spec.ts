import { randomUUID } from 'crypto';
import { DataSource, Repository } from 'typeorm';
import { RefreshToken } from '../../auth/entities/refresh-token.entity';
import { VerificationToken } from '../../auth/entities/verification-token.entity';
import { Channel } from '../../channels/entities/channel.entity';
import {
  cleanAllTables,
  createTestDataSource,
} from '../../test/create-test-data-source';
import { User } from '../../users/entities/user.entity';
import { generatePublicId } from '../public-id.util';
import { VideoStatus } from './video-status.enum';
import { Video } from './video.entity';

const ALL_ENTITIES = [User, Channel, RefreshToken, VerificationToken, Video];

describe('Video entity (integration)', () => {
  let dataSource: DataSource;
  let userRepository: Repository<User>;
  let channelRepository: Repository<Channel>;
  let videoRepository: Repository<Video>;

  beforeAll(async () => {
    dataSource = createTestDataSource(ALL_ENTITIES);
    await dataSource.initialize();
    userRepository = dataSource.getRepository(User);
    channelRepository = dataSource.getRepository(Channel);
    videoRepository = dataSource.getRepository(Video);
  });

  afterAll(async () => {
    await dataSource.destroy();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
  });

  let counter = 0;
  async function createChannel(): Promise<Channel> {
    counter += 1;
    const user = await userRepository.save(
      userRepository.create({
        email: `video_owner_${counter}@example.com`,
        password: 'hashed',
      }),
    );
    return channelRepository.save(
      channelRepository.create({
        name: `Channel ${counter}`,
        nickname: `video_owner_${counter}`,
        user_id: user.id,
      }),
    );
  }

  function buildVideo(
    channelId: string,
    overrides: Partial<Video> = {},
  ): Video {
    const id = randomUUID();
    return videoRepository.create({
      id,
      public_id: generatePublicId(),
      channel_id: channelId,
      title: 'aula',
      original_filename: 'aula.mp4',
      mime_type: 'video/mp4',
      size_bytes: '314572800',
      storage_key: `videos/${id}/original`,
      part_size_bytes: 104857600,
      part_count: 3,
      ...overrides,
    });
  }

  it('should persist a video as draft with every optional column null by default', async () => {
    const channel = await createChannel();

    const saved = await videoRepository.save(buildVideo(channel.id));
    const found = await videoRepository.findOneByOrFail({ id: saved.id });

    expect(found.status).toBe(VideoStatus.DRAFT);
    expect(found.failure_reason).toBeNull();
    expect(found.thumbnail_key).toBeNull();
    expect(found.upload_id).toBeNull();
    expect(found.duration_seconds).toBeNull();
    expect(found.width).toBeNull();
    expect(found.height).toBeNull();
    expect(found.video_codec).toBeNull();
    expect(found.metadata).toBeNull();
    expect(found.created_at).toBeInstanceOf(Date);
    expect(found.updated_at).toBeInstanceOf(Date);
  });

  it('should reject two videos with the same public_id', async () => {
    const channel = await createChannel();
    const publicId = generatePublicId();
    await videoRepository.save(buildVideo(channel.id, { public_id: publicId }));

    await expect(
      videoRepository.save(buildVideo(channel.id, { public_id: publicId })),
    ).rejects.toThrow(/unique|duplicate/i);
  });

  it('should reject a public_id longer than 11 characters', async () => {
    const channel = await createChannel();

    await expect(
      videoRepository.save(
        buildVideo(channel.id, { public_id: 'a'.repeat(12) }),
      ),
    ).rejects.toThrow();
  });

  it('should reject a video whose channel does not exist', async () => {
    await expect(
      videoRepository.save(buildVideo(randomUUID())),
    ).rejects.toThrow(/foreign key/i);
  });

  it('should delete the videos of a channel when the channel is deleted', async () => {
    const channel = await createChannel();
    const other = await createChannel();
    await videoRepository.save(buildVideo(channel.id));
    await videoRepository.save(buildVideo(channel.id));
    const kept = await videoRepository.save(buildVideo(other.id));

    await channelRepository.delete({ id: channel.id });

    const remaining = await videoRepository.find();
    expect(remaining.map((video) => video.id)).toEqual([kept.id]);
  });

  it('should accept each status of the lifecycle', async () => {
    const channel = await createChannel();

    for (const status of Object.values(VideoStatus)) {
      const saved = await videoRepository.save(
        buildVideo(channel.id, { status }),
      );
      const found = await videoRepository.findOneByOrFail({ id: saved.id });
      expect(found.status).toBe(status);
    }
  });

  it('should reject a status outside the enum', async () => {
    const channel = await createChannel();
    const saved = await videoRepository.save(buildVideo(channel.id));

    await expect(
      dataSource.query(
        `UPDATE "videos" SET "status" = 'published' WHERE id = $1`,
        [saved.id],
      ),
    ).rejects.toThrow(/invalid input value for enum/i);
  });

  it('should round-trip metadata as jsonb', async () => {
    const channel = await createChannel();
    const metadata = {
      format: { duration: '12.500000', format_name: 'mov,mp4,m4a,3gp,3g2,mj2' },
      streams: [{ codec_type: 'video', width: 1280, height: 720 }],
    };

    const saved = await videoRepository.save(
      buildVideo(channel.id, { metadata }),
    );
    const found = await videoRepository.findOneByOrFail({ id: saved.id });

    expect(found.metadata).toEqual(metadata);
    const [row] = await dataSource.query<{ codec_type: string }[]>(
      `SELECT metadata->'streams'->0->>'codec_type' AS codec_type FROM "videos" WHERE id = $1`,
      [saved.id],
    );
    expect(row.codec_type).toBe('video');
  });

  it('should store a 10GB size exactly and read it back as a string', async () => {
    const channel = await createChannel();

    const saved = await videoRepository.save(
      buildVideo(channel.id, { size_bytes: '10737418240' }),
    );
    const found = await videoRepository.findOneByOrFail({ id: saved.id });

    expect(found.size_bytes).toBe('10737418240');
    expect(Number(found.size_bytes)).toBe(10737418240);
  });

  it('should keep fractional durations without rounding', async () => {
    const channel = await createChannel();

    const saved = await videoRepository.save(
      buildVideo(channel.id, { duration_seconds: 12.345678 }),
    );
    const found = await videoRepository.findOneByOrFail({ id: saved.id });

    expect(found.duration_seconds).toBe(12.345678);
  });

  it('should load the owning channel and the inverse videos relation', async () => {
    const channel = await createChannel();
    const saved = await videoRepository.save(buildVideo(channel.id));

    const video = await videoRepository.findOneOrFail({
      where: { id: saved.id },
      relations: { channel: true },
    });
    const owner = await channelRepository.findOneOrFail({
      where: { id: channel.id },
      relations: { videos: true },
    });

    expect(video.channel.id).toBe(channel.id);
    expect(owner.videos.map((v) => v.id)).toEqual([saved.id]);
  });
});
