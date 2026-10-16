import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource, Repository } from 'typeorm';
import { StorageUploadNotFoundError } from '../src/storage/storage.errors';
import { StorageService } from '../src/storage/storage.service';
import { cleanAllTables } from '../src/test/create-test-data-source';
import {
  clearThrottler,
  createE2eApp,
  registerConfirmAndLogin,
} from '../src/test/e2e-helpers';
import { VideoStatus } from '../src/videos/entities/video-status.enum';
import { Video } from '../src/videos/entities/video.entity';

describe('Videos — restart upload and delete (e2e)', () => {
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

  const rowOf = () => videoRepository.findOneByOrFail({ public_id: videoId });

  const auth = (token: string | null) => (req: request.Test) =>
    token ? req.set('Authorization', `Bearer ${token}`) : req;

  const restart = (body: object = {}, token: string | null = ownerToken) =>
    auth(token)(
      request(app.getHttpServer())
        .post(`/videos/${videoId}/upload/restart`)
        .send(body),
    );

  const remove = (token: string | null = ownerToken) =>
    auth(token)(request(app.getHttpServer()).delete(`/videos/${videoId}`));

  // Aborts the multipart upload in the storage, then lets the API notice it
  // through GET .../upload/parts: the video ends failed/UPLOAD_EXPIRED the
  // same way it does in production.
  async function expireUpload(): Promise<void> {
    const row = await rowOf();
    await storageService.abortMultipartUpload(
      row.storage_key,
      row.upload_id as string,
    );
    await request(app.getHttpServer())
      .get(`/videos/${videoId}/upload/parts`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .expect(410);
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

  it('should reopen an expired upload on the same url with a fresh upload session', async () => {
    const oldUploadId = (await rowOf()).upload_id;
    await expireUpload();
    expect(await rowOf()).toMatchObject({
      status: VideoStatus.FAILED,
      failure_reason: 'UPLOAD_EXPIRED',
    });

    const response = await restart({ size_bytes: 209715200 }).expect(200);

    const body = response.body as {
      video: { id: string; status: string; failure_reason: string | null };
      upload: object;
    };
    expect(body.video).toMatchObject({
      id: videoId,
      status: 'draft',
      failure_reason: null,
    });
    expect(body.upload).toEqual({ part_size_bytes: 104857600, part_count: 2 });
    const row = await rowOf();
    expect(row.upload_id).toEqual(expect.any(String));
    expect(row.upload_id).not.toBe(oldUploadId);
    expect(row.size_bytes).toBe('209715200');

    const signed = await request(app.getHttpServer())
      .post(`/videos/${videoId}/upload/part-urls`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ part_numbers: [1] })
      .expect(200);
    const url = (signed.body as { parts: { url: string }[] }).parts[0].url;
    const put = await fetch(url, {
      method: 'PUT',
      body: Buffer.alloc(1024, 1),
    });
    expect(put.status).toBe(200);
    expect(put.headers.get('etag')).toBeTruthy();
    const listed = await request(app.getHttpServer())
      .get(`/videos/${videoId}/upload/parts`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .expect(200);
    expect(
      (listed.body as { uploaded_parts: { part_number: number }[] })
        .uploaded_parts,
    ).toEqual([expect.objectContaining({ part_number: 1 })]);
  });

  it('should refuse to restart a video that is not an expired upload', async () => {
    const states: { status?: VideoStatus; failure_reason?: string | null }[] = [
      {},
      { status: VideoStatus.FAILED, failure_reason: 'INVALID_MEDIA' },
      { status: VideoStatus.PROCESSING, failure_reason: null },
      { status: VideoStatus.READY, failure_reason: null },
    ];

    for (const state of states) {
      await videoRepository.update({ public_id: videoId }, state);
      const before = await rowOf();

      const response = await restart().expect(409);

      expect(response.body).toMatchObject({ error: 'INVALID_UPLOAD_STATE' });
      const after = await rowOf();
      expect(after.status).toBe(before.status);
      expect(after.failure_reason).toBe(before.failure_reason);
      expect(after.upload_id).toBe(before.upload_id);
    }
  });

  it('should delete a draft: multipart aborted, objects and row gone', async () => {
    const signed = await request(app.getHttpServer())
      .post(`/videos/${videoId}/upload/part-urls`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ part_numbers: [1] })
      .expect(200);
    const url = (signed.body as { parts: { url: string }[] }).parts[0].url;
    await fetch(url, { method: 'PUT', body: Buffer.alloc(1024, 1) });
    const row = await rowOf();

    const response = await remove().expect(204);

    expect(response.text).toBe('');
    await expect(videoRepository.findOneBy({ id: row.id })).resolves.toBeNull();
    await expect(
      storageService.listParts(row.storage_key, row.upload_id as string),
    ).rejects.toBeInstanceOf(StorageUploadNotFoundError);
    await expect(
      storageService.headObject(row.storage_key),
    ).rejects.toBeDefined();
  });

  it('should refuse to delete a ready or processing video and remove nothing', async () => {
    const row = await rowOf();
    await storageService.putObject(row.storage_key, 'video', 'video/mp4');

    for (const status of [VideoStatus.READY, VideoStatus.PROCESSING]) {
      await videoRepository.update(
        { public_id: videoId },
        { status, upload_id: null },
      );

      const response = await remove().expect(409);

      expect(response.body).toMatchObject({ error: 'INVALID_UPLOAD_STATE' });
      await expect(
        videoRepository.findOneBy({ id: row.id }),
      ).resolves.not.toBeNull();
      await expect(
        storageService.headObject(row.storage_key),
      ).resolves.toBeDefined();
    }
  });

  it('should answer 404 to another user and 401 to anonymous callers', async () => {
    await expireUpload();

    const strangerRestart = await restart({}, strangerToken).expect(404);
    expect(strangerRestart.body).toMatchObject({ error: 'VIDEO_NOT_FOUND' });
    expect(await rowOf()).toMatchObject({
      status: VideoStatus.FAILED,
      failure_reason: 'UPLOAD_EXPIRED',
    });

    const strangerDelete = await remove(strangerToken).expect(404);
    expect(strangerDelete.body).toMatchObject({ error: 'VIDEO_NOT_FOUND' });
    await expect(rowOf()).resolves.toBeDefined();

    await restart({}, null).expect(401);
    await remove(null).expect(401);
  });
});
