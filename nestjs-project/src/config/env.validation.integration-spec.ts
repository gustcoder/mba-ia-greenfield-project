import { readFileSync } from 'fs';
import { join } from 'path';
import { parse } from 'dotenv';
import { envValidationSchema } from './env.validation';
import queueConfig from './queue.config';
import storageConfig from './storage.config';
import videosConfig from './videos.config';

const requiredEnv = {
  DB_USERNAME: 'user',
  DB_PASSWORD: 'pass',
  DB_NAME: 'db',
  JWT_SECRET: 'secret',
  JWT_REFRESH_SECRET: 'refresh-secret',
  S3_ENDPOINT: 'http://minio:9000',
  S3_PUBLIC_ENDPOINT: 'http://minio:9000',
  S3_ACCESS_KEY: 'access',
  S3_SECRET_KEY: 'secret-key',
  S3_BUCKET: 'bucket',
  REDIS_HOST: 'redis',
};

const validate = (env: Record<string, string>) =>
  envValidationSchema.validate(
    { ...requiredEnv, ...env },
    { allowUnknown: true, abortEarly: false },
  );

describe('envValidationSchema — SWAGGER_ENABLED', () => {
  it('should reject SWAGGER_ENABLED with an invalid value', () => {
    const { error } = validate({ SWAGGER_ENABLED: 'invalid' });
    expect(error).toBeDefined();
    expect(error!.message).toContain('SWAGGER_ENABLED');
  });

  it('should accept SWAGGER_ENABLED=true', () => {
    const { error } = validate({ SWAGGER_ENABLED: 'true' });
    expect(error).toBeUndefined();
  });

  it('should accept SWAGGER_ENABLED=false', () => {
    const { error } = validate({ SWAGGER_ENABLED: 'false' });
    expect(error).toBeUndefined();
  });

  it('should apply default false when SWAGGER_ENABLED is not set', () => {
    const { value, error } = validate({});
    expect(error).toBeUndefined();
    expect(value.SWAGGER_ENABLED).toBe('false');
  });
});

describe('envValidationSchema — storage, queue and videos', () => {
  it('should accept the shipped .env.example as-is', () => {
    const example = parse(readFileSync(join(__dirname, '../../.env.example')));
    const { error } = envValidationSchema.validate(example, {
      allowUnknown: true,
      abortEarly: false,
    });
    expect(error).toBeUndefined();
  });

  it.each(['S3_ENDPOINT', 'S3_PUBLIC_ENDPOINT', 'S3_BUCKET', 'REDIS_HOST'])(
    'should reject a missing %s naming the key',
    (key) => {
      const { error } = envValidationSchema.validate(
        { ...requiredEnv, [key]: undefined },
        { allowUnknown: true, abortEarly: false },
      );
      expect(error).toBeDefined();
      expect(error!.message).toContain(key);
    },
  );

  it('should reject VIDEO_UPLOAD_PART_SIZE_BYTES below 5 MiB', () => {
    const { error } = validate({ VIDEO_UPLOAD_PART_SIZE_BYTES: '5242879' });
    expect(error).toBeDefined();
    expect(error!.message).toContain('VIDEO_UPLOAD_PART_SIZE_BYTES');
  });

  it('should accept VIDEO_UPLOAD_PART_SIZE_BYTES of exactly 5 MiB', () => {
    const { error } = validate({
      VIDEO_UPLOAD_PART_SIZE_BYTES: '5242880',
      VIDEO_MAX_SIZE_BYTES: '10485760',
    });
    expect(error).toBeUndefined();
  });

  it('should reject VIDEO_MAX_SIZE_BYTES smaller than the part size', () => {
    const { error } = validate({
      VIDEO_UPLOAD_PART_SIZE_BYTES: '104857600',
      VIDEO_MAX_SIZE_BYTES: '104857599',
    });
    expect(error).toBeDefined();
    expect(error!.message).toContain('VIDEO_MAX_SIZE_BYTES');
  });

  it.each([
    'VIDEO_UPLOAD_URL_TTL_SECONDS',
    'VIDEO_PLAYBACK_URL_TTL_SECONDS',
    'VIDEO_SOURCE_URL_TTL_SECONDS',
  ])('should reject %s above the 7-day presign limit', (key) => {
    const { error } = validate({ [key]: '604801' });
    expect(error).toBeDefined();
    expect(error!.message).toContain(key);
  });

  it('should apply the documented defaults', () => {
    const result = validate({});
    const value = result.value as Record<string, unknown>;
    expect(result.error).toBeUndefined();
    expect(value.VIDEO_MAX_SIZE_BYTES).toBe(10737418240);
    expect(value.VIDEO_UPLOAD_PART_SIZE_BYTES).toBe(104857600);
    expect(value.VIDEO_PROCESSING_ATTEMPTS).toBe(3);
    expect(value.VIDEO_PROCESSING_BACKOFF_MS).toBe(10000);
    expect(value.QUEUE_PREFIX).toBe('bull');
    expect(value.S3_FORCE_PATH_STYLE).toBe('true');
  });
});

describe('config namespaces under the test setup', () => {
  it('should resolve the test bucket and the test queue prefix', () => {
    expect(storageConfig().bucket).toBe('streamtube-videos-test');
    expect(queueConfig().prefix).toBe('bull-test');
  });

  it('should expose typed values from the environment', () => {
    expect(storageConfig().forcePathStyle).toBe(true);
    expect(queueConfig().port).toEqual(expect.any(Number));
    expect(videosConfig().maxSizeBytes).toBe(10737418240);
    expect(videosConfig().uploadPartSizeBytes).toBe(104857600);
  });
});
