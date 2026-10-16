import { Test } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import storageConfig from '../config/storage.config';
import { buildAttachmentDisposition } from './content-disposition';
import { StorageModule } from './storage.module';
import { StorageService } from './storage.service';

const INTERNAL_ENDPOINT = 'http://internal-host.test:9000';
const PUBLIC_ENDPOINT = 'http://public-host.test:9000';

const ENV_KEYS = [
  'S3_ENDPOINT',
  'S3_PUBLIC_ENDPOINT',
  'S3_REGION',
  'S3_ACCESS_KEY',
  'S3_SECRET_KEY',
  'S3_BUCKET',
  'S3_FORCE_PATH_STYLE',
] as const;

describe('StorageService — presigning (no network)', () => {
  let service: StorageService;
  let close: () => Promise<void>;
  const originalEnv: Partial<Record<(typeof ENV_KEYS)[number], string>> = {};

  beforeAll(async () => {
    for (const key of ENV_KEYS) originalEnv[key] = process.env[key];
    process.env.S3_ENDPOINT = INTERNAL_ENDPOINT;
    process.env.S3_PUBLIC_ENDPOINT = PUBLIC_ENDPOINT;
    process.env.S3_REGION = 'us-east-1';
    process.env.S3_ACCESS_KEY = 'access';
    process.env.S3_SECRET_KEY = 'secret';
    process.env.S3_BUCKET = 'unit-bucket';
    process.env.S3_FORCE_PATH_STYLE = 'true';

    const module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          ignoreEnvFile: true,
          load: [storageConfig],
        }),
        StorageModule,
      ],
    }).compile();
    service = module.get(StorageService);
    close = () => module.close();
  });

  afterAll(async () => {
    await close();
    for (const key of ENV_KEYS) {
      if (originalEnv[key] === undefined) delete process.env[key];
      else process.env[key] = originalEnv[key];
    }
  });

  it('should sign upload parts and GET urls against the public endpoint', async () => {
    const part = new URL(
      await service.presignUploadPart('videos/a/original', 'upload-1', 2, 600),
    );
    const get = new URL(await service.presignGet('videos/a/original', 600));
    expect(part.origin).toBe(PUBLIC_ENDPOINT);
    expect(get.origin).toBe(PUBLIC_ENDPOINT);
  });

  it('should sign the worker GET url against the internal endpoint', async () => {
    const url = new URL(
      await service.presignInternalGet('videos/a/original', 600),
    );
    expect(url.origin).toBe(INTERNAL_ENDPOINT);
  });

  it('should address the bucket and key path-style and carry the part parameters', async () => {
    const url = new URL(
      await service.presignUploadPart('videos/a/original', 'upload-1', 3, 600),
    );
    expect(url.pathname).toBe('/unit-bucket/videos/a/original');
    expect(url.searchParams.get('partNumber')).toBe('3');
    expect(url.searchParams.get('uploadId')).toBe('upload-1');
  });

  it('should apply the TTL and keep checksum params out of the part url', async () => {
    const url = new URL(
      await service.presignUploadPart('videos/a/original', 'upload-1', 1, 900),
    );
    expect(url.searchParams.get('X-Amz-Expires')).toBe('900');
    const names = [...url.searchParams.keys()].map((n) => n.toLowerCase());
    expect(names.filter((n) => n.includes('checksum'))).toEqual([]);
  });

  it('should sign the attachment disposition only when a filename is given', async () => {
    const plain = new URL(await service.presignGet('k', 600));
    const download = new URL(
      await service.presignGet('k', 600, { attachmentFilename: 'aula.mp4' }),
    );
    expect(plain.searchParams.has('response-content-disposition')).toBe(false);
    expect(download.searchParams.get('response-content-disposition')).toBe(
      'attachment; filename="aula.mp4"',
    );
  });
});

describe('buildAttachmentDisposition', () => {
  it('should keep a plain ASCII name as the only filename parameter', () => {
    expect(buildAttachmentDisposition('Minha Aula.mp4')).toBe(
      'attachment; filename="Minha Aula.mp4"',
    );
  });

  it('should add an ASCII fallback and an RFC 5987 name for non-ASCII input', () => {
    expect(buildAttachmentDisposition('Introdução à Física.mp4')).toBe(
      `attachment; filename="Introdu__o _ F_sica.mp4"; filename*=UTF-8''Introdu%C3%A7%C3%A3o%20%C3%A0%20F%C3%ADsica.mp4`,
    );
  });

  it('should not let quotes or backslashes break out of the quoted value', () => {
    const header = buildAttachmentDisposition('a"b\\c.mp4');
    expect(header.startsWith('attachment; filename="a_b_c.mp4"')).toBe(true);
    expect(header).toContain(`filename*=UTF-8''a%22b%5Cc.mp4`);
  });
});
