---
libs:
  "@nestjs/bullmq":
    version: "^12.0.0"
    context7_id: "/nestjs/bull"
    fetched_at: "2026-10-14T19:05:00-03:00"
  "bullmq":
    version: "^6.3.15"
    context7_id: "/websites/bullmq_io"
    fetched_at: "2026-10-14T19:05:00-03:00"
  "@aws-sdk/client-s3":
    version: "^3.1152.0"
    context7_id: "/aws/aws-sdk-js-v3"
    fetched_at: "2026-10-14T19:05:00-03:00"
  "@aws-sdk/s3-request-presigner":
    version: "^3.1152.0"
    context7_id: "/aws/aws-sdk-js-v3"
    fetched_at: "2026-10-14T19:05:00-03:00"
  "minio":
    version: "bitnamilegacy/minio:2025.7.23-debian-12-r5"
    context7_id: "/minio/docs"
    fetched_at: "2026-10-14T19:05:00-03:00"
sources_mtime:
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-10-14T19:04:00-03:00"
---

# Library References — phase-03-videos

Versions are the latest published on npm on 2026-10-14 (`npm view <pkg> version`), checked for compatibility with the installed stack (`nestjs-project/package.json`: NestJS 11, Node 25.6, TypeScript 5.7 `module: nodenext` → CommonJS output, Jest 30 + ts-jest). Excerpts are distilled from Context7 for the surfaces the phase's TDs use.

### @nestjs/bullmq

_Used by: phase-03-videos/TD-01 (queue), TD-02 (worker entrypoint), TD-07 (enqueue), TD-14 (failure handling)._

- **Compatibility:** `@nestjs/bullmq@12.0.0` peers `@nestjs/common` / `@nestjs/core` `^10 || ^11 || ^12` and `bullmq` `^3 || ^4 || ^5 || ^6` → compatible with the installed NestJS 11.
- **Root config (async, from config namespace):** `BullModule.forRootAsync({ imports, inject, useFactory: (cfg) => ({ connection: { host, port } }) })`. Fits the inherited convention `ConfigType<typeof xxxConfig>` + `@Inject(xxxConfig.KEY)` (phase 01).
- **Queue registration:** `BullModule.registerQueue({ name, defaultJobOptions })`. Options extend BullMQ `QueueOptions`; `forceDisconnectOnShutdown` defaults to `false`. On shutdown the module closes workers, then the queue.
- **Producer:** `@InjectQueue(name) private readonly queue: Queue` (type from `bullmq`), then `queue.add(jobName, data, opts)`.
- **Consumer:** a class decorated `@Processor(name, workerOptions?)` that extends `WorkerHost` and implements `process(job: Job): Promise<any>`. The second argument takes raw BullMQ `WorkerOptions` (e.g. `concurrency`). `worker` is only available after `onModuleInit`.
- **Worker events:** `@OnWorkerEvent('failed' | 'completed' | 'error' | ...)` on methods of the `@Processor` class. `BullExplorer.onApplicationShutdown` closes `@Processor` workers.
- **Testing:** get the queue via `moduleRef.get<Queue>(getQueueToken(name))` (`getQueueToken` is re-exported from `@nestjs/bullmq`). Module compilation tests should include `BullModule.registerQueue()` (testing-guide modules row). Close the app/module in `afterAll` so Redis handles don't keep Jest alive.

### bullmq

_Used by: phase-03-videos/TD-01, TD-07 (dedup), TD-14 (retries / fail-fast)._

- **Retries with backoff:** job options `{ attempts: N, backoff: { type: 'exponential', delay: ms } }`. Retry delay = `2^(attemptsMade-1) * delay`.
- **Fail-fast (no retry):** `throw new UnrecoverableError(msg)` inside the processor moves the job straight to `failed`, regardless of `attempts`. Use for invalid media detected by ffprobe (TD-14).
- **Final-failure detection:** a job is on its last attempt when `job.attemptsMade` (or `attemptsStarted`) reaches `job.opts.attempts`. Persist `status = failed` + reason only on that attempt or on `UnrecoverableError`.
- **Per-video dedup (TD-07 `jobId = videoId`):** `queue.add(name, data, { jobId })`. Adding a job whose ID already exists is ignored. Caveat from the docs: once a job is removed (`removeOnComplete` / `removeOnFail`), its ID no longer blocks a re-add. Retention therefore affects how long `complete` stays idempotent at the queue level. The DB status check in the service stays the primary idempotency guard.
- **Retention:** `removeOnComplete` / `removeOnFail` accept a count (e.g. `1000` / `5000`) or an age.
- **Stalled jobs:** if a worker dies, the job's lock expires and the stalled checker moves it back to `wait`, or to `failed` after max stalled count (default 1). Long FFmpeg runs keep their lock alive through automatic lock renewal while the process is healthy.
- **Redis requirement:** Redis must run with `maxmemory-policy noeviction`. Otherwise keys (jobs) can be evicted silently.

### @aws-sdk/client-s3

_Used by: phase-03-videos/TD-05 (multipart), TD-07 (complete / HeadObject), TD-09 (layout and endpoints), TD-13 (`NoSuchUpload` → `UPLOAD_EXPIRED`), TD-15 (tests against MinIO)._

- **Client for MinIO:** `new S3Client({ endpoint, region, credentials: { accessKeyId, secretAccessKey }, forcePathStyle: true })` (v3 renamed v2's `s3ForcePathStyle` to `forcePathStyle`). Create **one client per endpoint** and reuse it (EFFECTIVE_PRACTICES). TD-09 implies two instances: internal endpoint (Compose service name) for server calls, public endpoint for signing browser-facing URLs.
- **Multipart commands:** `CreateMultipartUploadCommand` (returns `UploadId`), `UploadPartCommand` (signed for the client, see the presigner section below), `ListPartsCommand` (resume, TD-06), `CompleteMultipartUploadCommand` with `MultipartUpload: { Parts: [{ PartNumber, ETag }] }`, `AbortMultipartUploadCommand`.
- **Object verification:** `HeadObjectCommand` → `ContentLength` (≤ 10GB check in TD-07).
- **Error handling:** service errors are matched by `error.name` (e.g. `'NoSuchKey'`, `'NoSuchUpload'`). TD-13 maps `NoSuchUpload` on a `draft` to `failed` / `UPLOAD_EXPIRED`.
- **ETag requirement:** the browser must be able to read the `ETag` response header of each part `PUT`. On AWS S3 this needs bucket CORS with `ExposeHeaders: ['ETag']` (`PutBucketCorsCommand`). On MinIO, see the `minio` section below.
- **S3 limits (AWS):** part size ≥ 5MiB (except the last part), ≤ 10,000 parts, single `PUT` ≤ 5GB (why TD-05 rejected a single presigned PUT).

### @aws-sdk/s3-request-presigner

_Used by: phase-03-videos/TD-04 (worker FFmpeg input), TD-05/TD-06 (part URLs), TD-11 (stream / download)._

- **API:** `getSignedUrl(client, command, { expiresIn })`. `expiresIn` is in seconds, default `900`; SigV4 maximum is 7 days.
- **Part URLs:** `getSignedUrl(publicClient, new UploadPartCommand({ Bucket, Key, UploadId, PartNumber }), { expiresIn })`. Signed against the public-endpoint client so the host in the URL is reachable from the browser (TD-09).
- **Download disposition:** `new GetObjectCommand({ Bucket, Key, ResponseContentDisposition: 'attachment; filename="…"' })`. Response-override parameters only work on signed requests, so a presigned URL is the right tool (TD-11).
- **Payload / headers:** presigned requests use `UNSIGNED-PAYLOAD`, and `content-type` is unsigned by default (opt in with `signableHeaders`). The presigned URL cannot enforce `Content-Length`, so size limits are enforced server-side via part arithmetic (TD-06) and `HeadObject` (TD-07).
- **Worker input (TD-04):** the worker signs a `GetObjectCommand` against the **internal** endpoint, since FFmpeg runs inside the Compose network. Its TTL must exceed the job's worst-case duration.

### minio

_Used by: phase-03-videos/TD-10 (local S3 server image), TD-09 (CORS), TD-14 (orphaned multipart), TD-15 (test infra)._

- **Image (TD-10 revision 2026-10-14):** `bitnamilegacy/minio:2025.7.23-debian-12-r5`. Official `minio/minio` and `quay.io/minio/minio` refuse anonymous pulls. Bitnami env: `MINIO_ROOT_USER`, `MINIO_ROOT_PASSWORD` (≥ 8 chars), `MINIO_DEFAULT_BUCKETS` (comma-separated, created at startup). API port 9000, console 9001. Companion CLI image if needed: `bitnamilegacy/minio-client:2025.7.21-debian-12-r3`.
- **CORS:** MinIO does **not** implement `PutBucketCors` / `DeleteBucketCors`. CORS is enabled by default on all buckets for all verbs, so no bucket-CORS bootstrap is needed locally. The production (AWS S3) bucket still needs a CORS rule exposing `ETag` (see the client-s3 section above).
- **Orphaned multipart uploads:** MinIO does **not** support the `AbortIncompleteMultipartUpload` lifecycle action. Incomplete uploads are reclaimed by the server's stale-upload expiry (server-side `api` config), and can be removed manually with `mc rm --incomplete --recursive --force ALIAS/PATH`. On AWS S3 the equivalent is a lifecycle rule. This backs TD-13's lazy `NoSuchUpload` → `UPLOAD_EXPIRED` detection and TD-14's note that application code does not clean multipart.
- **Multipart listing quirk:** `ListMultipartUploads` needs the exact object name as prefix. Per-upload resume uses `ListParts`, which is unaffected.
