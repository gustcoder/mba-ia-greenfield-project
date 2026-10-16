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

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0xff, 0xd9]);

interface PresignedUrl {
  url: string;
  expires_at: string;
}

describe('Videos — detail, stream and download (e2e)', () => {
  let app: INestApplication<App>;
  let dataSource: DataSource;
  let videoRepository: Repository<Video>;
  let storageService: StorageService;
  let ownerToken: string;
  let strangerToken: string;
  let videoId: string;

  const get = (path: string, token: string | null = ownerToken) => {
    const req = request(app.getHttpServer()).get(`/videos/${videoId}${path}`);
    return token ? req.set('Authorization', `Bearer ${token}`) : req;
  };

  // Simulates what the worker leaves behind (it does not run in this suite).
  async function makeReady(): Promise<void> {
    const row = await videoRepository.findOneByOrFail({ public_id: videoId });
    const thumbnailKey = `videos/${row.id}/thumbnail.jpg`;
    await storageService.putObject(
      row.storage_key,
      Buffer.alloc(4096, 7),
      'video/mp4',
    );
    await storageService.putObject(thumbnailKey, JPEG, 'image/jpeg');
    await videoRepository.update(
      { id: row.id },
      {
        status: VideoStatus.READY,
        upload_id: null,
        thumbnail_key: thumbnailKey,
        duration_seconds: 12.5,
        width: 1280,
        height: 720,
        video_codec: 'h264',
      },
    );
  }

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
        filename: 'Minha Aula.mp4',
        mime_type: 'video/mp4',
        size_bytes: 4096,
      })
      .expect(201);
    videoId = (created.body as { video: { id: string } }).video.id;
  });

  it('should reflect the current status and, once ready, the extracted metadata and a thumbnail url', async () => {
    const draft = await get('').expect(200);
    expect(draft.body).toMatchObject({
      id: videoId,
      status: 'draft',
      thumbnail_url: null,
      duration_seconds: null,
    });

    await makeReady();
    const ready = await get('').expect(200);

    const body = ready.body as {
      status: string;
      duration_seconds: number;
      width: number;
      height: number;
      video_codec: string;
      thumbnail_url: string | null;
    };
    expect(body).toMatchObject({
      status: 'ready',
      duration_seconds: 12.5,
      width: 1280,
      height: 720,
      video_codec: 'h264',
    });
    expect(body.thumbnail_url).toEqual(expect.any(String));
    const image = await fetch(body.thumbnail_url as string);
    expect(image.status).toBe(200);
    expect(Buffer.from(await image.arrayBuffer())).toEqual(JPEG);
  });

  it('should return a stream url whose Range request is answered with 206', async () => {
    await makeReady();

    const response = await get('/stream').expect(200);

    const { url, expires_at } = response.body as PresignedUrl;
    expect(typeof url).toBe('string');
    expect(Date.parse(expires_at)).toBeGreaterThan(Date.now());
    const partial = await fetch(url, { headers: { Range: 'bytes=0-1023' } });
    expect(partial.status).toBe(206);
    expect((await partial.arrayBuffer()).byteLength).toBe(1024);
    expect(partial.headers.get('content-range')).toMatch(/^bytes 0-1023\/4096/);
  });

  it('should return a download url that forces an attachment with the original name', async () => {
    await makeReady();

    const response = await get('/download').expect(200);

    const { url, expires_at } = response.body as PresignedUrl;
    expect(Date.parse(expires_at)).toBeGreaterThan(Date.now());
    const file = await fetch(url);
    expect(file.status).toBe(200);
    const disposition = file.headers.get('content-disposition') ?? '';
    expect(disposition).toContain('attachment');
    expect(disposition).toContain('filename="Minha Aula.mp4"');
  });

  it('should answer 409 VIDEO_NOT_READY to stream and download unless the video is ready', async () => {
    const states = [
      { status: VideoStatus.DRAFT },
      { status: VideoStatus.PROCESSING },
      { status: VideoStatus.FAILED, failure_reason: 'PROCESSING_FAILED' },
    ];

    for (const state of states) {
      await videoRepository.update({ public_id: videoId }, state);
      for (const path of ['/stream', '/download']) {
        const response = await get(path).expect(409);
        expect(response.body).toMatchObject({ error: 'VIDEO_NOT_READY' });
      }
    }
  });

  it("should answer 404 for another user's or an unknown video and 401 without a token", async () => {
    await makeReady();

    for (const path of ['', '/stream', '/download']) {
      const response = await get(path, strangerToken).expect(404);
      expect(response.body).toMatchObject({ error: 'VIDEO_NOT_FOUND' });
    }
    const unknown = await request(app.getHttpServer())
      .get('/videos/AAAAAAAAAAA')
      .set('Authorization', `Bearer ${ownerToken}`)
      .expect(404);
    expect(unknown.body).toMatchObject({ error: 'VIDEO_NOT_FOUND' });

    for (const path of ['', '/stream', '/download']) {
      await get(path, null).expect(401);
    }
  });
});
