import { INestApplication } from '@nestjs/common';
import { getQueueToken } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource, Repository } from 'typeorm';
import videosConfig from '../src/config/videos.config';
import { StorageService } from '../src/storage/storage.service';
import { cleanAllTables } from '../src/test/create-test-data-source';
import {
  clearThrottler,
  createE2eApp,
  registerConfirmAndLogin,
} from '../src/test/e2e-helpers';
import { VideoStatus } from '../src/videos/entities/video-status.enum';
import { Video } from '../src/videos/entities/video.entity';
import {
  VIDEO_PROCESSING_QUEUE,
  type ProcessVideoJobData,
} from '../src/videos/processing/video-processing.constants';

interface UploadedPart {
  videoId: string;
  etag: string;
}

describe('Videos — complete upload (e2e)', () => {
  let app: INestApplication<App>;
  let dataSource: DataSource;
  let videoRepository: Repository<Video>;
  let storageService: StorageService;
  let queue: Queue<ProcessVideoJobData>;
  let ownerToken: string;
  let videoId: string;
  let etag: string;

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

  // POST /videos, sign part 1 and PUT `bytes` bytes straight to the storage.
  async function startAndUploadPart(
    target: INestApplication<App>,
    token: string,
    declaredSize: number,
    bytes: number,
  ): Promise<UploadedPart> {
    const created = await request(target.getHttpServer())
      .post('/videos')
      .set('Authorization', `Bearer ${token}`)
      .send({
        filename: 'aula.mp4',
        mime_type: 'video/mp4',
        size_bytes: declaredSize,
      })
      .expect(201);
    const id = (created.body as { video: { id: string } }).video.id;
    const signed = await request(target.getHttpServer())
      .post(`/videos/${id}/upload/part-urls`)
      .set('Authorization', `Bearer ${token}`)
      .send({ part_numbers: [1] })
      .expect(200);
    const url = (signed.body as { parts: { url: string }[] }).parts[0].url;
    const put = await fetch(url, {
      method: 'PUT',
      body: Buffer.alloc(bytes, 1),
    });
    return { videoId: id, etag: put.headers.get('etag') as string };
  }

  const complete = (
    body: object,
    id: string = videoId,
    target: INestApplication<App> = app,
    token: string = ownerToken,
  ) =>
    request(target.getHttpServer())
      .post(`/videos/${id}/upload/complete`)
      .set('Authorization', `Bearer ${token}`)
      .send(body);

  const partsBody = () => ({ parts: [{ part_number: 1, etag }] });

  const rowOf = (publicId: string) =>
    videoRepository.findOneByOrFail({ public_id: publicId });

  const jobsFor = async (uuid: string) =>
    (
      await queue.getJobs(['waiting', 'delayed', 'active', 'prioritized'])
    ).filter((job) => job.id === uuid);

  beforeAll(async () => {
    app = await createE2eApp();
    dataSource = app.get(DataSource);
    videoRepository = dataSource.getRepository(Video);
    storageService = app.get(StorageService, { strict: false });
    queue = app.get<Queue<ProcessVideoJobData>>(
      getQueueToken(VIDEO_PROCESSING_QUEUE),
      { strict: false },
    );
  });

  afterAll(async () => {
    await abortOpenUploads();
    await storageService.deletePrefix('videos/');
    await queue.obliterate({ force: true });
    await app.close();
  });

  beforeEach(async () => {
    await abortOpenUploads();
    await cleanAllTables(dataSource);
    await storageService.deletePrefix('videos/');
    await queue.obliterate({ force: true });
    clearThrottler(app);
    ({ access_token: ownerToken } = await registerConfirmAndLogin(
      app,
      'owner@example.com',
    ));
    ({ videoId, etag } = await startAndUploadPart(app, ownerToken, 1024, 1024));
  });

  it('should complete the upload and enqueue the process-video job', async () => {
    const response = await complete(partsBody()).expect(200);

    expect(response.body).toMatchObject({ id: videoId, status: 'processing' });
    const row = await rowOf(videoId);
    expect(row).toMatchObject({
      status: VideoStatus.PROCESSING,
      upload_id: null,
      size_bytes: '1024',
    });
    await expect(storageService.headObject(row.storage_key)).resolves.toEqual(
      expect.objectContaining({ contentLength: 1024 }),
    );
    const job = await queue.getJob(row.id);
    expect(job?.name).toBe('process-video');
    expect(job?.data).toEqual({ videoId: row.id });
  });

  it('should be idempotent when repeated', async () => {
    await complete(partsBody()).expect(200);
    const again = await complete(partsBody()).expect(200);

    expect(again.body).toMatchObject({ status: 'processing' });
    expect(await jobsFor((await rowOf(videoId)).id)).toHaveLength(1);
  });

  it('should reject a wrong ETag, keep the draft and accept the correct one afterwards', async () => {
    const before = await rowOf(videoId);

    const wrong = await complete({
      parts: [{ part_number: 1, etag: `"${'0'.repeat(32)}"` }],
    }).expect(400);

    expect(wrong.body).toMatchObject({ error: 'INVALID_UPLOAD_PARTS' });
    const draft = await rowOf(videoId);
    expect(draft.status).toBe(VideoStatus.DRAFT);
    expect(draft.upload_id).toBe(before.upload_id);
    await complete(partsBody())
      .expect(200)
      .expect((res) => {
        expect((res.body as { status: string }).status).toBe('processing');
      });
  });

  it('should fail the video as FILE_TOO_LARGE when the assembled object is above the limit', async () => {
    const limited = await createE2eApp((builder) =>
      builder.overrideProvider(videosConfig.KEY).useValue({
        ...videosConfig(),
        maxSizeBytes: 512,
      }),
    );
    try {
      const { access_token: token } = await registerConfirmAndLogin(
        limited,
        'limited@example.com',
      );
      const uploaded = await startAndUploadPart(limited, token, 512, 1024);

      const response = await complete(
        { parts: [{ part_number: 1, etag: uploaded.etag }] },
        uploaded.videoId,
        limited,
        token,
      ).expect(400);

      expect(response.body).toMatchObject({ error: 'VIDEO_TOO_LARGE' });
      const row = await rowOf(uploaded.videoId);
      expect(row).toMatchObject({
        status: VideoStatus.FAILED,
        failure_reason: 'FILE_TOO_LARGE',
      });
      await expect(
        storageService.headObject(row.storage_key),
      ).rejects.toBeDefined();
      expect(await jobsFor(row.id)).toHaveLength(0);
    } finally {
      await limited.close();
    }
  });

  it('should answer 409 for a failed video and enqueue nothing', async () => {
    await videoRepository.update(
      { public_id: videoId },
      { status: VideoStatus.FAILED, failure_reason: 'INVALID_MEDIA' },
    );

    const response = await complete(partsBody()).expect(409);

    expect(response.body).toMatchObject({ error: 'INVALID_UPLOAD_STATE' });
    expect(await jobsFor((await rowOf(videoId)).id)).toHaveLength(0);
  });

  it('should answer 410 and fail the video when the multipart upload expired', async () => {
    const row = await rowOf(videoId);
    await storageService.abortMultipartUpload(
      row.storage_key,
      row.upload_id as string,
    );

    const response = await complete(partsBody()).expect(410);

    expect(response.body).toMatchObject({ error: 'UPLOAD_EXPIRED' });
    expect(await rowOf(videoId)).toMatchObject({
      status: VideoStatus.FAILED,
      failure_reason: 'UPLOAD_EXPIRED',
      upload_id: null,
    });
    expect(await jobsFor(row.id)).toHaveLength(0);
  });

  it('should reject a malformed body and an unauthenticated call', async () => {
    const invalid = await complete({ parts: [] }).expect(400);
    expect(invalid.body).toMatchObject({ error: 'VALIDATION_ERROR' });

    await request(app.getHttpServer())
      .post(`/videos/${videoId}/upload/complete`)
      .send(partsBody())
      .expect(401);
  });
});
