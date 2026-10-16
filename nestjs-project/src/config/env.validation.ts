import * as Joi from 'joi';

// S3 multipart: every part except the last must be at least 5 MiB.
const MIN_PART_SIZE_BYTES = 5 * 1024 * 1024;
// SigV4 presigned URLs are valid for at most 7 days.
const MAX_PRESIGN_TTL_SECONDS = 604800;

export const envValidationSchema = Joi.object({
  NODE_ENV: Joi.string()
    .valid('development', 'production', 'test')
    .default('development'),
  PORT: Joi.number().port().default(3000),
  DB_HOST: Joi.string().default('localhost'),
  DB_PORT: Joi.number().default(5432),
  DB_USERNAME: Joi.string().required(),
  DB_PASSWORD: Joi.string().required(),
  DB_NAME: Joi.string().required(),
  JWT_SECRET: Joi.string().required(),
  JWT_REFRESH_SECRET: Joi.string().required(),
  JWT_ACCESS_EXPIRATION: Joi.string().default('15m'),
  JWT_REFRESH_EXPIRATION: Joi.string().default('7d'),
  CONFIRMATION_TOKEN_EXPIRATION_HOURS: Joi.number().default(1),
  PASSWORD_RESET_TOKEN_EXPIRATION_HOURS: Joi.number().default(1),
  APP_URL: Joi.string().uri().default('http://localhost:3000'),
  MAIL_HOST: Joi.string().default('mailpit'),
  MAIL_PORT: Joi.number().default(1025),
  MAIL_FROM: Joi.string().default('"StreamTube" <noreply@streamtube.com>'),
  SWAGGER_ENABLED: Joi.string().valid('true', 'false').default('false'),
  S3_ENDPOINT: Joi.string().uri().required(),
  S3_PUBLIC_ENDPOINT: Joi.string().uri().required(),
  S3_REGION: Joi.string().default('us-east-1'),
  S3_ACCESS_KEY: Joi.string().required(),
  S3_SECRET_KEY: Joi.string().required(),
  S3_BUCKET: Joi.string().required(),
  S3_FORCE_PATH_STYLE: Joi.string().valid('true', 'false').default('true'),
  REDIS_HOST: Joi.string().required(),
  REDIS_PORT: Joi.number().port().default(6379),
  QUEUE_PREFIX: Joi.string().default('bull'),
  VIDEO_UPLOAD_PART_SIZE_BYTES: Joi.number()
    .integer()
    .min(MIN_PART_SIZE_BYTES)
    .default(104857600),
  VIDEO_MAX_SIZE_BYTES: Joi.number()
    .integer()
    .min(Joi.ref('VIDEO_UPLOAD_PART_SIZE_BYTES'))
    .default(10737418240),
  VIDEO_UPLOAD_URL_TTL_SECONDS: Joi.number()
    .integer()
    .min(1)
    .max(MAX_PRESIGN_TTL_SECONDS)
    .default(3600),
  VIDEO_PLAYBACK_URL_TTL_SECONDS: Joi.number()
    .integer()
    .min(1)
    .max(MAX_PRESIGN_TTL_SECONDS)
    .default(3600),
  VIDEO_SOURCE_URL_TTL_SECONDS: Joi.number()
    .integer()
    .min(1)
    .max(MAX_PRESIGN_TTL_SECONDS)
    .default(21600),
  VIDEO_PROCESSING_ATTEMPTS: Joi.number().integer().min(1).default(3),
  VIDEO_PROCESSING_BACKOFF_MS: Joi.number().integer().min(0).default(10000),
});
