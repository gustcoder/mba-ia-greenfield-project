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
import { VideoStatus } from '../src/videos/entities/video-status.enum';
import { Video } from '../src/videos/entities/video.entity';

interface SignedParts {
  parts: { part_number: number; url: string }[];
  expires_at: string;
}

describe('Videos — upload part urls and parts (e2e)', () => {
  let app: INestApplication<App>;
  let dataSource: DataSource;
  let videoRepository: Repository<Video>;
  let storageService: StorageService;
  let ownerToken: string;
  let strangerToken: string;
  let videoId: string;

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
    ({ access_token: ownerToken } = await registerConfirmAndLogin(
      app,
      'owner@example.com',
    ));
    ({ access_token: strangerToken } = await registerConfirmAndLogin(
      app,
      'stranger@example.com',
    ));
    const created = await request(app.getHttpServer())
      .post('/videos')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({
        filename: 'aula.mp4',
        mime_type: 'video/mp4',
        size_bytes: 314572800,
      })
      .expect(201);
    videoId = (created.body as { video: { id: string } }).video.id;
  });

  const signParts = (
    body: object,
    token: string | null = ownerToken,
    id = videoId,
  ) => {
    const req = request(app.getHttpServer()).post(
      `/videos/${id}/upload/part-urls`,
    );
    return (token ? req.set('Authorization', `Bearer ${token}`) : req).send(
      body,
    );
  };

  const listParts = (token: string | null = ownerToken, id = videoId) => {
    const req = request(app.getHttpServer()).get(`/videos/${id}/upload/parts`);
    return token ? req.set('Authorization', `Bearer ${token}`) : req;
  };

  async function putPart(url: string, bytes = 1024): Promise<string> {
    const response = await fetch(url, {
      method: 'PUT',
      body: new Uint8Array(bytes).fill(1),
    });
    expect(response.status).toBe(200);
    return response.headers.get('etag') as string;
  }

  async function expireUpload(): Promise<void> {
    const row = await videoRepository.findOneByOrFail({ public_id: videoId });
    await storageService.abortMultipartUpload(
      row.storage_key,
      row.upload_id as string,
    );
  }

  it('should sign part urls that the storage accepts', async () => {
    const res = await signParts({ part_numbers: [1, 2] }).expect(200);

    const body = res.body as SignedParts;
    expect(body.parts).toHaveLength(2);
    expect(body.parts.map((p) => p.part_number)).toEqual([1, 2]);
    expect(body.parts.every((p) => typeof p.url === 'string')).toBe(true);
    expect(Date.parse(body.expires_at)).toBeGreaterThan(Date.now());
    expect(await putPart(body.parts[0].url)).toBeTruthy();
  });

  it('should list the parts already sent so the upload can resume', async () => {
    const signed = (await signParts({ part_numbers: [1] }).expect(200))
      .body as SignedParts;
    const etag = await putPart(signed.parts[0].url);

    const res = await listParts().expect(200);

    expect(res.body).toEqual({
      part_size_bytes: 104857600,
      part_count: 3,
      uploaded_parts: [{ part_number: 1, etag, size_bytes: 1024 }],
    });
    expect(JSON.stringify(res.body)).not.toMatch(/upload_id|storage_key/);
  });

  it('should reject part numbers above part_count with INVALID_PART_NUMBER and below 1 as a validation error', async () => {
    const above = await signParts({ part_numbers: [4] }).expect(400);
    const zero = await signParts({ part_numbers: [0] }).expect(400);

    expect(above.body).toMatchObject({ error: 'INVALID_PART_NUMBER' });
    expect(zero.body).toMatchObject({ error: 'VALIDATION_ERROR' });
  });

  it('should refuse a video that is no longer a draft', async () => {
    await videoRepository.update(
      { public_id: videoId },
      { status: VideoStatus.PROCESSING },
    );

    const res = await signParts({ part_numbers: [1] }).expect(409);

    expect(res.body).toMatchObject({ error: 'INVALID_UPLOAD_STATE' });
  });

  it('should answer 410 and fail the video when the multipart upload expired', async () => {
    await expireUpload();

    const res = await listParts().expect(410);

    expect(res.body).toMatchObject({ error: 'UPLOAD_EXPIRED' });
    const row = await videoRepository.findOneByOrFail({ public_id: videoId });
    expect(row).toMatchObject({
      status: 'failed',
      failure_reason: 'UPLOAD_EXPIRED',
      upload_id: null,
    });
  });

  it('should answer 404 VIDEO_NOT_FOUND identically for another user, unknown and malformed ids, and 401 without a token', async () => {
    const stranger = await listParts(strangerToken).expect(404);
    const unknown = await listParts(ownerToken, 'AAAAAAAAAAA').expect(404);
    const malformed = await listParts(ownerToken, 'invalid!').expect(404);
    const strangerSign = await signParts(
      { part_numbers: [1] },
      strangerToken,
    ).expect(404);

    for (const res of [stranger, unknown, malformed, strangerSign]) {
      expect(res.body).toMatchObject({ error: 'VIDEO_NOT_FOUND' });
    }
    expect(unknown.body).toEqual(stranger.body);
    expect(malformed.body).toEqual(stranger.body);
    await listParts(null).expect(401);
    await signParts({ part_numbers: [1] }, null).expect(401);
  });

  it('should detect an expired multipart upload when signing part urls too', async () => {
    await expireUpload();

    const res = await signParts({ part_numbers: [1] }).expect(410);

    expect(res.body).toMatchObject({ error: 'UPLOAD_EXPIRED' });
    expect(res.body).not.toHaveProperty('parts');
    const row = await videoRepository.findOneByOrFail({ public_id: videoId });
    expect(row).toMatchObject({
      status: 'failed',
      failure_reason: 'UPLOAD_EXPIRED',
      upload_id: null,
    });
  });
});
