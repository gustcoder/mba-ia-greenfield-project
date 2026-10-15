import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource, Repository } from 'typeorm';
import { StorageService } from '../src/storage/storage.service';
import { cleanAllTables } from '../src/test/create-test-data-source';
import {
  clearThrottler,
  createE2eApp,
  registerConfirmAndLogin,
} from '../src/test/e2e-helpers';
import { Video } from '../src/videos/entities/video.entity';
import { Channel } from '../src/channels/entities/channel.entity';

const VALID_BODY = {
  filename: 'aula.mp4',
  mime_type: 'video/mp4',
  size_bytes: 314572800,
};

describe('Videos — POST /videos (e2e)', () => {
  let app: INestApplication<App>;
  let dataSource: DataSource;
  let videoRepository: Repository<Video>;
  let storageService: StorageService;
  let accessToken: string;

  async function abortOpenUploads(): Promise<void> {
    const open = await dataSource.query<
      { storage_key: string; upload_id: string }[]
    >(
      `SELECT storage_key, upload_id FROM "videos" WHERE upload_id IS NOT NULL`,
    );
    for (const { storage_key, upload_id } of open) {
      await storageService.abortMultipartUpload(storage_key, upload_id);
    }
  }

  beforeAll(async () => {
    app = await createE2eApp();
    dataSource = app.get(DataSource);
    videoRepository = dataSource.getRepository(Video);
    storageService = app.get(StorageService, { strict: false });
  });

  afterAll(async () => {
    await abortOpenUploads();
    await storageService.deletePrefix('videos/');
    await app.close();
  });

  beforeEach(async () => {
    await abortOpenUploads();
    await cleanAllTables(dataSource);
    await storageService.deletePrefix('videos/');
    clearThrottler(app);
    ({ access_token: accessToken } = await registerConfirmAndLogin(
      app,
      'owner@example.com',
    ));
  });

  const post = (body: object, token: string | null = accessToken) => {
    const req = request(app.getHttpServer()).post('/videos');
    return (token ? req.set('Authorization', `Bearer ${token}`) : req).send(
      body,
    );
  };

  it('should create the draft and open the multipart upload', async () => {
    const res = await post(VALID_BODY).expect(201);

    const body = res.body as {
      video: Record<string, unknown>;
      upload: Record<string, unknown>;
    };
    expect(body.video).toMatchObject({
      status: 'draft',
      title: 'aula',
      original_filename: 'aula.mp4',
      mime_type: 'video/mp4',
      size_bytes: 314572800,
      failure_reason: null,
      thumbnail_url: null,
      duration_seconds: null,
      width: null,
      height: null,
      video_codec: null,
    });
    expect(body.video.id).toMatch(/^[A-Za-z0-9_-]{11}$/);
    expect(body.upload).toEqual({
      part_size_bytes: 104857600,
      part_count: 3,
    });

    const json = JSON.stringify(res.body);
    expect(json).not.toMatch(
      /upload_id|storage_key|channel_id|public_id|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/,
    );

    const rows = await videoRepository.findBy({
      public_id: body.video.id as string,
    });
    expect(rows).toHaveLength(1);
    const [row] = rows;
    const channel = await dataSource
      .getRepository(Channel)
      .findOneByOrFail({ id: row.channel_id });
    expect(channel.nickname).toBe('owner');
    expect(row).toMatchObject({
      status: 'draft',
      storage_key: `videos/${row.id}/original`,
      part_size_bytes: 104857600,
      part_count: 3,
    });
    expect(row.upload_id).toEqual(expect.any(String));

    await expect(
      storageService.listParts(row.storage_key, row.upload_id as string),
    ).resolves.toEqual([]);
  });

  it('should reject a MIME type outside the allowlist and create nothing', async () => {
    const res = await post({
      filename: 'foto.png',
      mime_type: 'image/png',
      size_bytes: 1024,
    }).expect(400);

    expect(res.body).toMatchObject({
      statusCode: 400,
      error: 'UNSUPPORTED_MEDIA_TYPE',
    });
    expect(await videoRepository.count()).toBe(0);
  });

  it('should reject a size above the limit and create nothing', async () => {
    const res = await post({
      filename: 'grande.mp4',
      mime_type: 'video/mp4',
      size_bytes: 10737418241,
    }).expect(400);

    expect(res.body).toMatchObject({ error: 'VIDEO_TOO_LARGE' });
    expect(await videoRepository.count()).toBe(0);
  });

  it('should reject a body without filename as a validation error', async () => {
    const res = await post({ mime_type: 'video/mp4', size_bytes: 1024 }).expect(
      400,
    );

    expect(res.body).toMatchObject({ error: 'VALIDATION_ERROR' });
    expect(await videoRepository.count()).toBe(0);
  });

  it('should answer 401 without a token and create nothing', async () => {
    await post(VALID_BODY, null).expect(401);

    expect(await videoRepository.count()).toBe(0);
  });
});
