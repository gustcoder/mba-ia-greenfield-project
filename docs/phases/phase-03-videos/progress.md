# phase-03-videos — Progress

**Status:** in_progress
**SIs:** 8/13 completed

### SI-03.1 — Infra: dependências, imagem com FFmpeg e serviços Redis/MinIO no Compose
- **Status:** completed
- **Tests:** no tests (Infra) — 5/5 acceptance criteria verified manually (services healthy, ffmpeg/ffprobe 5.1.9, `noeviction`, both buckets created, health 200 container-to-container, ports bound to 127.0.0.1)
- **Observations:**
  - Redis pinned to `redis:8.2.2`; MinIO healthcheck uses the service name (`http://minio:9000`), per TD-09 revision.
  - Appended `MINIO_ROOT_USER` / `MINIO_ROOT_PASSWORD` to the local (gitignored) `.env` too, otherwise Compose starts MinIO with empty credentials.
  - Out of scope (inherited): `.env.example`'s `MAIL_FROM="StreamTube" <...>` still breaks the Compose parser when copied verbatim — already tracked for the Phase 02 bugfix branch.

### SI-03.2 — Configurar namespaces de storage, fila e vídeos
- **Status:** completed
- **Tests:** 21 passing (`src/config`, 17 new in `env.validation.integration-spec.ts`); real bootstrap verified: boots with the full `.env`, fails naming `S3_ENDPOINT` / `REDIS_HOST` when empty; e2e smoke passes; `tsc --noEmit` 0
- **Observations:**
  - Plan did not define defaults for the three presigned-URL TTLs; chose upload 3600 s, playback 3600 s, source (worker) 21600 s (6 h, above any realistic FFmpeg job).
  - Plan did not list `.env` keys for `S3_ACCESS_KEY` / `S3_SECRET_KEY` values; set them equal to `MINIO_ROOT_USER` / `MINIO_ROOT_PASSWORD` (the MinIO root account is the only credential in dev).
  - `test/jest-e2e.json` resolves `<rootDir>` to `test/`, so the setup file is `<rootDir>/../src/test/setup-test-env.ts` (the plan only said "registered in `setupFiles`").
  - Added `.env.example` parse-and-validate test (AC1), so the example cannot drift from the schema.
  - Lint: no new errors (3 pre-existing in `env.validation.integration-spec.ts` line 47/49 and `create-test-data-source.ts`).

### SI-03.3 — Implementar StorageModule (S3 multipart, presign e objetos)
- **Status:** completed
- **Tests:** 21 passing in `src/storage` (12 integration against real MinIO, 8 unit with no network, 1 module compilation); Jest exits on its own (~4.6 s, no `--forceExit` needed); test bucket left empty; `tsc --noEmit` 0; eslint/prettier clean on the new files
- **Observations:**
  - Added the unit spec `storage.service.spec.ts` (not in the plan's Tests table, but required to prove which S3 client signs which URL, since in dev/test both endpoints are `http://minio:9000` per the TD-09 revision); also covers `buildAttachmentDisposition`.
  - Both `S3Client`s are built with `requestChecksumCalculation: 'WHEN_REQUIRED'` so presigned `UploadPart` URLs carry no CRC32 query params (a browser PUT could not satisfy them); asserted in the unit spec.
  - `completeMultipartUpload` sorts parts ascending before sending, so a client sending them unordered does not hit `InvalidPartOrder`.
  - Content-Disposition: plain ASCII names yield exactly `attachment; filename="<name>"`; names with non-ASCII, quotes or backslashes get an ASCII fallback plus `filename*=UTF-8''…` (RFC 6266), so the header cannot be broken out of.
  - MinIO treats a second `AbortMultipartUpload` on an aborted upload as a no-op (resolves), whereas `ListParts`/`Complete` raise `NoSuchUpload`. The service still translates `NoSuchUpload` on abort, so SI-03.9's "ignore `StorageUploadNotFoundError`" stays correct for AWS S3.
  - `deletePrefix` removes objects only; open multipart uploads under the prefix must be aborted by the caller (SI-03.9 already does so).
  - `StorageModule` is not yet imported by any feature module or `AppModule`; `VideosModule` (SI-03.6) does that.

### SI-03.4 — Criar entidade Video, migration CreateVideos e gerador de ID público
- **Status:** completed
- **Tests:** 33 new/affected passing: `public-id.util.spec.ts` (unit), `video.entity.integration-spec.ts` (11, real Postgres), 2 new `CreateVideos` tests in `migrations.integration-spec.ts`. Regression: 189/189 in users/auth/channels/config/storage/videos/mail suites; e2e 52/52; `tsc --noEmit` 0; prettier clean; eslint: no new errors. Inherited failure in `migrations.integration-spec.ts` unchanged (1 failed + afterAll error, same `verification_tokens_type_enum already exists`).
- **Observations:**
  - **Needed beyond the plan:** a minimal `VideosModule` (`TypeOrmModule.forFeature([Video])` only) registered in `AppModule`. Without an owning module registering `Video`, the inverse `Channel.videos` relation makes the whole app fail at bootstrap ("Entity metadata for Channel#videos was not found"), and the repo rule requires registering an entity in its owning module as soon as it exists. SI-03.6 will extend this module (Storage/Channels imports, controller, services) and add `videos.module.spec.ts`.
  - **Needed beyond the plan:** `Video` added to the entity list of the 9 specs that declare `[User, Channel, RefreshToken, VerificationToken]` (same reason: Channel now references Video) and to the existing DataSource of `migrations.integration-spec.ts` (list only; its setup and assertions are untouched).
  - `size_bytes` is typed `string` on the entity (pg returns bigint as string), per the plan's TypeORM note; the mapper/service layer converts to `number` and must write `String(size)`.
  - Dropped the explicit `enumName: 'videos_status_enum'`: with it, TypeORM's `migration:generate` kept proposing a no-op rename/recreate of the enum (spurious diff). The default name is already `videos_status_enum`; `generate` now reports "No changes". The committed migration was generated before that edit; its SQL is identical.
  - The new migration test block lives in its own `describe` with a full reset (tables **and** enums) so it does not depend on the inherited failure. As a side effect the suite now leaves the shared DB fully migrated (3 migrations, `videos` present) instead of empty.
  - Housekeeping on the local dev DB (per `typeorm-migrations.md` recovery): the inherited failure had left it with no tables and a stray `verification_tokens_type_enum`; dropped the enum and `migrations` table, then ran `migration:run` to apply all 3 migrations.
  - Acceptance criterion #5 (`migration:revert` drops `videos` + enum) verified both by CLI and by the new down test. Lint: only the pre-existing `Function` error in `create-test-data-source.ts`.

### SI-03.5 — Configurar a fila BullMQ e o producer `video-processing`
- **Status:** completed
- **Tests:** 6 passing (5 integration against real Redis with prefix `bull-test` + 1 module compilation); Jest exits by itself in ~2 s with no `--forceExit` (AC4); regression: e2e 52/52 (also without `--forceExit`), 195/195 in users/auth/channels/config/storage/videos/mail; compiled app (`nest build` + `node dist/main`) boots; `tsc --noEmit` 0; eslint and prettier clean on the SI files
- **Observations:**
  - **Library gap — `ioredis` is not bundled in `bullmq@6`:** it is an optional peer that must be installed, otherwise `new Queue()` fails with "BullMQ could not load the optional 'ioredis' package". Installed `ioredis@^5.11.1`. Not `6.x`: `typeorm@0.3.28` declares `peerOptional ioredis@^5.0.4`, so 5.x is the only line satisfying both TypeORM and BullMQ (`>=5.0.0`); `npm install ioredis@^6` fails with ERESOLVE. `library-refs.md` does not list it and should be updated in a planning pass.
  - **Library gap — `@nestjs/bullmq@12` and `@nestjs/bull-shared@12` are ESM-only (`"type": "module"`).** Node 25.6 loads them through `require(esm)` (verified in the compiled app), but Jest's CommonJS runtime cannot ("Unexpected token 'export'"). Added `test/esm-to-cjs.transformer.js` (TypeScript `transpileModule`, no new dependency) and, in both `package.json` `jest` and `test/jest-e2e.json`, a `.js` transform plus `transformIgnorePatterns` limited to these two packages. Every Jest run (unit, integration, e2e) now goes through that config; `test/*.js` is outside the `lint` glob (`*.ts` only).
  - Used `BullModule.registerQueueAsync` (not `registerQueue` as written in the plan) because `attempts`/`backoff` come from the `videos` config namespace and need DI. Retention: `removeOnComplete` 1000 / `removeOnFail` 5000 as constants (values from `library-refs.md`).
  - `QueueModule` (`forRootAsync`, connection + prefix from the `queue` namespace) is imported by `AppModule`; `VideoProcessingQueueModule` is NOT imported by `VideosModule` yet — that is SI-03.8.
  - BullMQ 6 `queue.client` is an adapter without `keys()`; the prefix-isolation test opens a plain `ioredis` connection instead.
  - No dedicated `queue.module.spec.ts`: `VideoProcessingQueueModule`'s spec compiles `QueueModule` (the `forRootAsync` wiring) together with it.

### SI-03.6 — Endpoint POST /videos (pré-cadastro do rascunho e abertura do upload)
- **Status:** completed
- **Tests:** new in this SI: 5 e2e (`test/videos-create.e2e-spec.ts`, from `specs/videos-create.plan.md`, 5/5 scenarios, all 7 ACs), 20 unit (`video-uploads.service.spec.ts`), 5 integration against real Postgres + MinIO (`video-uploads.service.integration-spec.ts`), 1 module compilation, plus unit specs for the mapper (4), title util (11), pg-unique util (3) and 2 `findByUserId` integration tests. Regression: 234/234 in videos/channels/storage/users/auth/config; e2e 57/57 (twice in a row); `tsc --noEmit` 0; eslint/prettier clean on every file touched by this SI (6 pre-existing errors remain in the old helper at the top of `channels.service.ts`, lines 12–16); full unit/integration run: only the inherited migrations failure. The generated OpenAPI doc for `POST /videos` was inspected (bearer security, request/response schemas, 400/401 with `ApiErrorEnvelope`).
- **Observations:**
  - **Fixed a latent e2e race:** `test:e2e` ran suites in parallel against one shared DB (CLAUDE.md says "always `--runInBand`, already configured", but the script had no flag). With a 4th e2e file the new suite failed with `500` on login (another file's `DELETE FROM` ran concurrently). Added `--runInBand` to the `test:e2e` script; two consecutive runs are 57/57.
  - Renamed the plan's `UnsupportedMediaTypeException` to `UnsupportedVideoTypeException` (error code stays `UNSUPPORTED_MEDIA_TYPE`): the original name collides with Nest's HTTP `UnsupportedMediaTypeException`, and a wrong auto-import would silently change the response format. All videos exceptions live in `src/videos/exceptions/video.exceptions.ts`.
  - Added shared e2e helpers `src/test/e2e-helpers.ts` (`createE2eApp`, `registerConfirmAndLogin`, `clearThrottler`) for the 5 controller e2e suites of this phase; `auth.e2e-spec.ts` was not touched. The app has a global 10 req/min throttler, so each suite resets it after login (`beforeEach`); a test that fires many requests must stay under 10.
  - Response mapping is an injectable `VideoResponseMapper.toVideoResponse(video)` (needs `StorageService` to sign the thumbnail with the playback TTL), not a free function; it is the single place that hides `uuid`/`upload_id`/`storage_key`/`channel_id` and converts the bigint `size_bytes` to `number`. SI-03.12 reuses it.
  - Extra behaviour not in the plan: if persisting the draft fails after the multipart upload was opened, the upload is aborted (compensation) and the original error is rethrown (an abort failure is only logged). A `public_id` collision re-rolls the id up to 5 times without reopening the multipart; each attempt is a plain statement, not a transaction.
  - A user without a channel (broken registration invariant) yields a plain `Error` → HTTP 500, not a domain error: there is no such code in the Error Catalog and the 1:1 user↔channel invariant is guaranteed at registration. `ChannelsService.findByUserId` was added for this.
  - `isUniqueViolationOnColumn` (videos) duplicates the private `isPgUniqueViolationOnColumn` of `channels.service.ts`; deduplicating would be a refactor of Phase 02 code (out of scope) — candidate for a follow-up task.
  - `VideosModule` now has controller + `VideoUploadsService` + mapper (imports `StorageModule`, `ChannelsModule`); `VideoProcessingQueueModule` is still to be imported by SI-03.8. `src/metadata.ts` (swagger CLI plugin metadata) and `openapi.json` are not regenerated yet — SI-03.13.

### SI-03.7 — Endpoints de assinatura de partes e retomada do upload
- **Status:** completed
- **Tests:** new in this SI: 7 e2e (`test/videos-upload-parts.e2e-spec.ts`: the 6 scenarios of `specs/videos-upload-parts.plan.md` covering all 6 ACs + 1 extra), 22 unit for `signParts`/`listUploadedParts` (in `video-uploads.service.spec.ts`), 8 unit for `VideosService`, 3 integration for `findOwnedByPublicId` (`videos.service.integration-spec.ts`), 7 integration for sign/list against real Postgres + MinIO (real `PUT` into a presigned URL, real abort). Regression: 266/266 in videos/channels/storage/users/auth/config; e2e 64/64; `tsc --noEmit` 0; eslint/prettier clean on every file touched; bucket left empty.
- **Observations:**
  - **Design decision beyond the plan — `signParts` probes the storage first (`ListParts`).** Presigning is a local computation and never reaches the storage, so the plan's "treat `StorageUploadNotFoundError` in these operations" could only ever fire in `listUploadedParts`; in `signParts` it would have been dead code and the client would learn about the expiry only after uploading 100 MiB parts into a dead multipart. Cost: one extra storage round trip per sign call. If that cost is not wanted, drop `listPartsOrExpire` from `signParts` (and the 1.7 scenario); everything else stays valid.
  - Added scenario **1.7** (`part-urls-detecta-multipart-expirado`) to `specs/videos-upload-parts.plan.md` with `Source: manual`, so `/plan-test-specs` will never overwrite or regenerate it; the spec file is still newer than the plan (no STALE).
  - Check order for `part-urls`: ownership (404) → state (409) → part numbers above `part_count` (400 `INVALID_PART_NUMBER`) → storage probe (410). `part_numbers` below 1 are rejected earlier by the DTO as `VALIDATION_ERROR`, per the TD-06 revision.
  - `VideosService` owns the lookup (`findOwnedByPublicId`: format check → one query joining `channel.user_id`), so no `ChannelsService` dependency; `VideoUploadsService` consumes it. Uniform 404 for malformed id, unknown id and other user's video (asserted identical in e2e and integration).
  - The `etag` is returned exactly as the storage reports it (quoted, e.g. `"9bb5…"`), i.e. the same value the browser reads from the `ETag` header of the part `PUT`; the client sends it back as-is in `complete` (SI-03.8).
  - `expireUpload` in tests aborts the multipart upload directly in MinIO (the only way to simulate expiry without waiting for the server's stale-upload reaper).
  - New constant `VideoFailureReason` in `videos.constants.ts` (used here for `UPLOAD_EXPIRED`; the other reasons are for SI-03.8/03.11).
  - Pending for SI-03.13: `src/metadata.ts` and `openapi.json` still need regeneration for these two routes.

### SI-03.8 — Endpoint de conclusão do upload com enfileiramento do processamento
- **Status:** completed
- **Tests:** new/affected passing: 7 e2e (`test/videos-upload-complete.e2e-spec.ts`: the 6 scenarios of `specs/videos-upload-complete.plan.md` covering all 6 ACs + 1 validation/401 wiring test), 48 unit in `video-uploads.service.spec.ts` (13 new for `complete`), 18 integration in `video-uploads.service.integration-spec.ts` (6 new, real Postgres + MinIO + Redis, real 5 MiB + 1 KiB multipart), 1 module compilation. Regression: full e2e 71/71 (6 suites); `tsc --noEmit` 0; eslint and prettier clean on every file touched; Jest exits by itself (no `--forceExit`)
- **Observations:**
  - `failExpiredUpload` (shared by `listPartsOrExpire` and `complete`) now updates with `WHERE id AND status = 'draft'`: a late `NoSuchUpload` from a concurrent second `complete` must not flip a video that the first call already moved to `processing` to `failed`. The two existing unit assertions on the criteria were adjusted accordingly; behaviour for the SI-03.7 endpoints is unchanged.
  - `complete` returns the freshly reloaded row after the `processing` update (the mapper needs the new `updated_at`); an enqueue failure after the status was saved surfaces as an error, and a retry takes the `processing` branch that re-enqueues (jobId dedup), as the plan intends.
  - `CompleteVideoUploadDto` validates `parts` as a non-empty array (max 10 000, the S3 limit) of `{ part_number: 1..10000, etag: non-empty string }` with `@ValidateNested` + `@Type`; duplicate/unordered parts are left to the storage (`InvalidPartOrder` → `INVALID_UPLOAD_PARTS`; the service already sorts).
  - `createE2eApp` (shared helper) takes an optional `customize(builder)` callback so the FILE_TOO_LARGE e2e can `overrideProvider(videosConfig.KEY)` on a second app instance, as the spec requires; existing callers are unaffected.
  - `VideosModule` now imports `VideoProcessingQueueModule`; `videos.module.spec.ts` and the service integration spec add `QueueModule` + `queueConfig` (the queue's `forRootAsync` connection is a global provider the module compilation needs).
  - The FILE_TOO_LARGE branch is covered by unit (limit boundary: exactly at limit accepted) and e2e (real override, real object deletion); no integration test for it, since the limit lives in config and the e2e is the faithful version.
  - Pending for SI-03.13: `src/metadata.ts` and `openapi.json` still need regeneration for this route.

### SI-03.9 — Endpoints de reinício do upload expirado e exclusão do vídeo não processado
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-03.10 — Implementar o serviço de mídia (ffprobe e thumbnail via FFmpeg)
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-03.11 — Implementar o worker de vídeo (entrypoint, processor e serviço no Compose)
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-03.12 — Endpoints de detalhe, streaming e download do vídeo
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-03.13 — Atualizar o contrato OpenAPI e a documentação de IA (seção de vídeos)
- **Status:** pending
- **Tests:** —
- **Observations:** none
