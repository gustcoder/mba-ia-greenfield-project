import { randomUUID } from 'crypto';
import { Test } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import storageConfig from '../config/storage.config';
import { StorageModule } from './storage.module';
import {
  StorageInvalidPartsError,
  StorageObjectNotFoundError,
  StorageUploadNotFoundError,
} from './storage.errors';
import { StorageService } from './storage.service';

const MIN_PART_BYTES = 5 * 1024 * 1024;
const TTL_SECONDS = 600;

describe('StorageService (MinIO)', () => {
  let service: StorageService;
  let closeModule: () => Promise<void>;
  const runPrefix = `storage-spec/${randomUUID()}`;

  const putPart = async (
    key: string,
    uploadId: string,
    partNumber: number,
    body: Buffer,
  ): Promise<string> => {
    const url = await service.presignUploadPart(
      key,
      uploadId,
      partNumber,
      TTL_SECONDS,
    );
    const response = await fetch(url, {
      method: 'PUT',
      body: new Uint8Array(body),
    });
    expect(response.status).toBe(200);
    const etag = response.headers.get('etag');
    expect(etag).toBeTruthy();
    return etag as string;
  };

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [storageConfig] }),
        StorageModule,
      ],
    }).compile();
    service = module.get(StorageService);
    closeModule = () => module.close();
  });

  afterAll(async () => {
    await service.deletePrefix(`${runPrefix}/`);
    await closeModule();
  });

  it('should assemble a two-part upload sent through presigned PUT urls', async () => {
    const key = `${runPrefix}/two-parts/original`;
    const uploadId = await service.createMultipartUpload(key, 'video/mp4');
    const part1 = Buffer.alloc(MIN_PART_BYTES, 1);
    const part2 = Buffer.alloc(1024, 2);

    const etag1 = await putPart(key, uploadId, 1, part1);
    const etag2 = await putPart(key, uploadId, 2, part2);
    await service.completeMultipartUpload(key, uploadId, [
      { partNumber: 1, etag: etag1 },
      { partNumber: 2, etag: etag2 },
    ]);

    const head = await service.headObject(key);
    expect(head.contentLength).toBe(part1.length + part2.length);
    expect(head.contentType).toBe('video/mp4');
  });

  it('should list only the parts already sent, with etag and size', async () => {
    const key = `${runPrefix}/partial/original`;
    const uploadId = await service.createMultipartUpload(key, 'video/mp4');
    expect(await service.listParts(key, uploadId)).toEqual([]);

    const etag = await putPart(key, uploadId, 1, Buffer.alloc(MIN_PART_BYTES));

    expect(await service.listParts(key, uploadId)).toEqual([
      { partNumber: 1, etag, sizeBytes: MIN_PART_BYTES },
    ]);
    await service.abortMultipartUpload(key, uploadId);
  });

  it('should raise StorageUploadNotFoundError once the upload is aborted', async () => {
    const key = `${runPrefix}/aborted/original`;
    const uploadId = await service.createMultipartUpload(key, 'video/mp4');
    await service.abortMultipartUpload(key, uploadId);

    await expect(service.listParts(key, uploadId)).rejects.toBeInstanceOf(
      StorageUploadNotFoundError,
    );
    await expect(
      service.completeMultipartUpload(key, uploadId, [
        { partNumber: 1, etag: '"x"' },
      ]),
    ).rejects.toBeInstanceOf(StorageUploadNotFoundError);
    // MinIO treats a repeated abort as a no-op (AWS S3 may answer NoSuchUpload,
    // which the service translates the same way as above).
    await expect(
      service.abortMultipartUpload(key, uploadId),
    ).resolves.toBeUndefined();
  });

  it('should raise StorageInvalidPartsError for a wrong etag', async () => {
    const key = `${runPrefix}/bad-etag/original`;
    const uploadId = await service.createMultipartUpload(key, 'video/mp4');
    await putPart(key, uploadId, 1, Buffer.alloc(MIN_PART_BYTES));

    await expect(
      service.completeMultipartUpload(key, uploadId, [
        { partNumber: 1, etag: '"00000000000000000000000000000000"' },
      ]),
    ).rejects.toBeInstanceOf(StorageInvalidPartsError);

    // the upload stays open so the client can retry with the right data
    expect(await service.listParts(key, uploadId)).toHaveLength(1);
    await service.abortMultipartUpload(key, uploadId);
  });

  it('should raise StorageInvalidPartsError when a non-last part is under 5 MiB', async () => {
    const key = `${runPrefix}/too-small/original`;
    const uploadId = await service.createMultipartUpload(key, 'video/mp4');
    const etag1 = await putPart(key, uploadId, 1, Buffer.alloc(1024));
    const etag2 = await putPart(key, uploadId, 2, Buffer.alloc(1024));

    await expect(
      service.completeMultipartUpload(key, uploadId, [
        { partNumber: 1, etag: etag1 },
        { partNumber: 2, etag: etag2 },
      ]),
    ).rejects.toBeInstanceOf(StorageInvalidPartsError);
    await service.abortMultipartUpload(key, uploadId);
  });

  it('should accept parts in any order by sending them ascending', async () => {
    const key = `${runPrefix}/unordered/original`;
    const uploadId = await service.createMultipartUpload(key, 'video/mp4');
    const etag1 = await putPart(key, uploadId, 1, Buffer.alloc(MIN_PART_BYTES));
    const etag2 = await putPart(key, uploadId, 2, Buffer.alloc(10));

    await service.completeMultipartUpload(key, uploadId, [
      { partNumber: 2, etag: etag2 },
      { partNumber: 1, etag: etag1 },
    ]);

    expect((await service.headObject(key)).contentLength).toBe(
      MIN_PART_BYTES + 10,
    );
  });

  it('should raise StorageObjectNotFoundError when the object is missing', async () => {
    await expect(
      service.headObject(`${runPrefix}/missing/original`),
    ).rejects.toBeInstanceOf(StorageObjectNotFoundError);
  });

  it('should delete every object under a prefix and nothing else', async () => {
    const target = `${runPrefix}/delete/video-a`;
    const sibling = `${runPrefix}/delete/video-b`;
    await service.putObject(`${target}/original`, 'one', 'text/plain');
    await service.putObject(`${target}/thumbnail.jpg`, 'two', 'image/jpeg');
    await service.putObject(`${sibling}/original`, 'keep', 'text/plain');

    await service.deletePrefix(`${target}/`);

    await expect(
      service.headObject(`${target}/original`),
    ).rejects.toBeInstanceOf(StorageObjectNotFoundError);
    await expect(
      service.headObject(`${target}/thumbnail.jpg`),
    ).rejects.toBeInstanceOf(StorageObjectNotFoundError);
    expect(
      (await service.headObject(`${sibling}/original`)).contentLength,
    ).toBe(4);
  });

  it('should delete a prefix larger than one listing page', async () => {
    const prefix = `${runPrefix}/many`;
    await Promise.all(
      Array.from({ length: 1005 }, (_, i) =>
        service.putObject(`${prefix}/o-${i}`, 'x', 'text/plain'),
      ),
    );

    await service.deletePrefix(`${prefix}/`);

    await expect(service.headObject(`${prefix}/o-0`)).rejects.toBeInstanceOf(
      StorageObjectNotFoundError,
    );
    await expect(service.headObject(`${prefix}/o-1004`)).rejects.toBeInstanceOf(
      StorageObjectNotFoundError,
    );
  }, 60000);

  describe('presigned GET', () => {
    const key = `${runPrefix}/get/original`;
    const content = Buffer.alloc(4096, 7);

    beforeAll(async () => {
      await service.putObject(key, content, 'video/mp4');
    });

    it('should answer 206 with exactly 100 bytes to a Range request', async () => {
      const url = await service.presignGet(key, TTL_SECONDS);

      const response = await fetch(url, { headers: { Range: 'bytes=0-99' } });

      expect(response.status).toBe(206);
      expect((await response.arrayBuffer()).byteLength).toBe(100);
      expect(response.headers.get('content-range')).toBe('bytes 0-99/4096');
    });

    it('should force a download with the original filename', async () => {
      const url = await service.presignGet(key, TTL_SECONDS, {
        attachmentFilename: 'Minha Aula.mp4',
      });

      const response = await fetch(url);

      expect(response.status).toBe(200);
      expect(response.headers.get('content-disposition')).toBe(
        'attachment; filename="Minha Aula.mp4"',
      );
    });

    it('should serve the object through the internal endpoint url', async () => {
      const url = await service.presignInternalGet(key, TTL_SECONDS);

      const response = await fetch(url);

      expect(response.status).toBe(200);
      expect((await response.arrayBuffer()).byteLength).toBe(content.length);
    });
  });
});
