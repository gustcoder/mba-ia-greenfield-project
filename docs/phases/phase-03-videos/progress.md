# phase-03-videos — Progress

**Status:** in_progress
**SIs:** 4/13 completed

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
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-03.6 — Endpoint POST /videos (pré-cadastro do rascunho e abertura do upload)
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-03.7 — Endpoints de assinatura de partes e retomada do upload
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-03.8 — Endpoint de conclusão do upload com enfileiramento do processamento
- **Status:** pending
- **Tests:** —
- **Observations:** none

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
