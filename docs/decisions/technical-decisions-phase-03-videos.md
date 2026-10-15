---
scope_type: phase
related_phases: [3]
status: decided
date: 2026-10-14
scope_description: "Backend + infra for video upload and processing: queue technology, worker topology, FFmpeg processing, 10GB direct-to-storage upload, completion trigger, unique video IDs, storage layout and local S3 server, streaming/download delivery and access, status lifecycle, failure policy, and test strategy for storage/queue."
---

# Technical Decisions — Phase 03: Upload e Processamento de Vídeos

_Subprojects in scope:_

- `nestjs-project/` — receives the `videos` module (API), the video worker (FFmpeg), the `videos` migration, and the new Compose services (object storage, queue broker, worker) in `nestjs-project/compose.yaml`. Every TD below covers it.
- `next-frontend/` — no UI in this phase (the challenge scope states the video interface is out of scope for Phase 03). No Frontend-scoped TD. The `Cross-layer` TDs (TD-05, TD-06, TD-08, TD-09, TD-11) fix the HTTP/storage contract the future frontend will consume, but nothing is implemented in `next-frontend/` now.

**Inherited constraints (not reopened):** `@nestjs/config` + Joi env validation with `registerAs` namespaces (phase-01-configuracao-base/TD-01..TD-04); custom JWT guard with global auth + `@Public()` (phase-02-auth/TD-02); `{ statusCode, error, message }` domain error contract (phase-02-auth/TD-07); class-validator DTOs (phase-02-auth/TD-06); `@nestjs/throttler` (phase-02-auth/TD-08); `@nestjs/swagger` + exported `openapi.json` (openapi-docs-nestjs/TD-01, TD-02). Object storage is **S3-compatible** by project definition (architecture diagram: "S3 or MinIO") — only *how* it is used is decided here.

**Installed versions checked** (`nestjs-project/package.json`): NestJS 11, TypeORM 0.3.28, PostgreSQL 17 (Compose), Node 25.6 (`Dockerfile.dev`, `node:25.6.0-slim`), TypeScript 5.7 with `module: nodenext` (CommonJS output), Jest 30 + ts-jest. None of the candidate libraries (BullMQ, AWS SDK v3, pg-boss, nanoid ≥4) is installed yet — exact versions are pinned later by `plan-resolve` in `library-refs.md`.

---

## TD-01: Queue Technology (Message Queue "TBD" in the architecture)

**Scope:** Backend

**Capability:** Serviço de processamento em segundo plano (filas)

**Context:** The architecture diagram leaves the Message Queue as "TBD". It carries video-processing jobs from the API to the worker. Jobs are long-running (ffprobe + frame extraction on files up to 10GB), must survive worker crashes, need retries with backoff, and must not be duplicated for the same video. The choice adds (or not) a new Compose service and a NestJS integration module.

**Options:**

### Option A: BullMQ + Redis (`@nestjs/bullmq`)
- Redis-backed job queue. `@nestjs/bullmq` provides `BullModule.forRoot/registerQueue`, `@InjectQueue()` for producers and `@Processor()` + `WorkerHost` for consumers. Jobs support `attempts` + exponential `backoff`, custom `jobId` / `deduplication` (one active job per video), lock renewal and stalled-job recovery.
- **Pros:** First-class NestJS package and the pattern recommended by the `nestjs-best-practices` skill (`micro-use-queues`) and anticipated by `testing-guide-nestjs-project` (`BullModule.registerQueue()` compilation tests). Retries, backoff, dedup, concurrency and `UnrecoverableError` are built in. Redis image is tiny and starts in <1s.
- **Cons:** New infra service (Redis) to run and back up. Job state lives outside PostgreSQL — enqueue cannot be atomic with the DB write (needs idempotent re-enqueue; see TD-07). Redis must run with `maxmemory-policy noeviction` or jobs may be silently evicted.

### Option B: RabbitMQ (AMQP)
- Dedicated message broker; NestJS integrates via `@nestjs/microservices` RMQ transport or `@golevelup/nestjs-rabbitmq`. Retries/backoff are built with dead-letter exchanges + TTL queues.
- **Pros:** True broker semantics (exchanges, routing, fan-out) that would scale to many event types/services. Language-agnostic — a non-Node worker could consume. Management UI included.
- **Cons:** Heaviest option (Erlang VM, slower startup). Retry/backoff/dedup are hand-built (DLX topologies) instead of job options. Default `consumer_timeout` (30 min) can kill acks of very long jobs unless tuned. The NestJS RMQ transport is message-oriented, not job-oriented — no job state, progress, or "one job per video" primitive.

### Option C: pg-boss (PostgreSQL-backed queue)
- Job queue stored in a `pgboss` schema of the existing PostgreSQL. `send()` with `retryLimit`/`retryBackoff`/`singletonKey`; `work()` polls with `SKIP LOCKED`. Can enqueue using the same DB connection/transaction as the business write.
- **Pros:** Zero new infrastructure. Enqueue can be transactional with the video status update (no lost/ghost jobs). Job history is queryable with SQL.
- **Cons:** No official NestJS module (custom provider/lifecycle wiring). Polling adds DB load and latency; queue traffic competes with app queries on the same database. Not the queue envisioned by the project's testing guide; smaller ecosystem.

**Recommendation:** **Option A (BullMQ + Redis)** — it is the only option where retries, backoff, per-video dedup and stalled-job recovery are job options instead of hand-built topology, it has an official NestJS integration the project's skills already target, and the cost (one small Redis service) is lower than RabbitMQ's; pg-boss's transactional enqueue is attractive but the idempotent "complete" flow in TD-07 already removes the lost-job risk without coupling the queue to the app database.

**Decision:** A (BullMQ + Redis via `@nestjs/bullmq`)
**Libraries:** @nestjs/bullmq, bullmq

---

## TD-02: Video Worker Runtime Topology

**Scope:** Backend

**Capability:** Transversal — covers: "Serviço de processamento em segundo plano (filas)", "Processamento automático do vídeo após upload (extração de duração e metadados)"

**Context:** The architecture defines a separate "Video Worker (FFmpeg)" container that consumes the queue, reads/writes storage and updates the DB. FFmpeg work is CPU- and I/O-heavy and must not degrade API latency. Where the worker code lives decides how it reuses the `Video` entity, TypeORM config, env validation and test tooling — and which images need the `ffmpeg` binary. Depends on TD-01.

**Options:**

### Option A: Same `nestjs-project/` codebase, second entrypoint, separate Compose service
- Add a worker entrypoint (e.g., `src/worker.ts`) that boots a Nest **application context** (`NestFactory.createApplicationContext`, no HTTP server) with a `WorkerModule` registering the processor. Compose gets a `video-worker` service built from the same project, running that entrypoint.
- **Pros:** Reuses entities, config namespaces, Joi validation, data-source and test helpers with zero duplication. One `package.json`, one lint/tsc/test pipeline (DoD stays a single run). Independent process/container → CPU isolation from the API and independent scaling.
- **Cons:** API and worker share one dependency set (the API image also carries worker deps). Requires discipline so the API module graph does not import the processor (and vice-versa). `ffmpeg` must be installed in the image(s) where worker tests run.

### Option B: Separate subproject (e.g., `video-worker/` at repo root)
- An independent Node project with its own `package.json`, Dockerfile and tests; talks to the same DB/queue/storage.
- **Pros:** Hard isolation of dependencies and deploy lifecycle; worker could later be rewritten in another language.
- **Cons:** Duplicates the `Video` entity/schema knowledge, config validation and test infra (or forces a shared-package/monorepo tooling decision not yet made). Two DoD pipelines. Schema drift risk between API migrations and worker model.

### Option C: Processor inside the API process
- Register the `@Processor()` in the API's `VideosModule`; the API process consumes its own queue.
- **Pros:** Simplest wiring — no extra service or entrypoint.
- **Cons:** FFmpeg child processes and stream I/O share the API container's CPU/memory — exactly the "impact on performance" the capability forbids. Contradicts the architecture diagram (separate worker container) and the challenge's explicit "worker" deliverable.

**Recommendation:** **Option A (same codebase, separate entrypoint and container)** — gives the process/CPU isolation the architecture requires while keeping a single schema source and a single DoD pipeline; installing `ffmpeg` in the shared dev image (so worker integration tests run in the same container as the rest of the suite) is a one-line Dockerfile change.

**Decision:** A (Same `nestjs-project/` codebase, separate worker entrypoint + Compose service)

---

## TD-03: FFmpeg / ffprobe Invocation Strategy

**Scope:** Backend

**Capability:** Transversal — covers: "Processamento automático do vídeo após upload (extração de duração e metadados)", "Geração automática de thumbnail a partir de um frame do vídeo"

**Context:** The worker must extract duration/metadata (ffprobe) and render one frame as a thumbnail (ffmpeg). Node has no native FFmpeg bindings; the choice is how binaries are obtained and invoked. Depends on TD-02 (which image carries the binary).

**Options:**

### Option A: System `ffmpeg`/`ffprobe` from the OS package + `child_process.spawn` wrapper
- Install via `apt-get install ffmpeg` in the Dockerfile (Debian-based `node:*-slim`). A small typed service spawns `ffprobe -v error -print_format json -show_format -show_streams <input>` and `ffmpeg -ss <t> -i <input> -frames:v 1 ...`, parsing JSON stdout and exit codes.
- **Pros:** No third-party JS dependency; ffprobe's JSON output maps directly to typed DTOs. Distro build includes the network protocols needed by TD-04 (http/https input). Full control over args, timeouts and stderr capture for error reporting.
- **Cons:** A thin wrapper (spawn, timeout, JSON parse, error mapping) must be written and tested. Binary version is whatever the Debian release ships.

### Option B: `fluent-ffmpeg`
- Popular fluent JS API over the FFmpeg CLI (`ffprobe()`, `.screenshots()`).
- **Pros:** Convenient helpers (e.g., screenshots at percentages); large amount of examples online.
- **Cons:** **Deprecated on npm** and no longer maintained (last release 2.1.3, maintainers sought). Still needs a system binary. Adding an unmaintained dependency to a greenfield phase is a liability.

### Option C: `ffmpeg-static` / `ffprobe-static` npm binaries + `spawn`
- npm packages that download prebuilt static binaries at install time; invoked the same way as Option A.
- **Pros:** Binary version pinned in `package-lock.json`; no Dockerfile change.
- **Cons:** Large install-time downloads into `node_modules` (bind-mounted in this project's dev setup), postinstall network dependency, and platform-specific binaries (host vs container architecture mismatch when `node_modules` is shared through the bind mount).

**Recommendation:** **Option A (system binaries + small spawn wrapper)** — Docker already defines the runtime, so the OS package is the most reliable source of the binary; it avoids an unmaintained wrapper (B) and the bind-mounted `node_modules` platform pitfalls of static npm binaries (C).

**Decision:** A (System `ffmpeg`/`ffprobe` from apt + `child_process.spawn` wrapper)

**Revisions:**

- 2026-10-14 — Metadata contract fixed: typed columns for the essentials (`duration_seconds`, `width`, `height`, `video_codec`, `size_bytes`) plus a JSONB `metadata` column holding the summarized ffprobe `format`/`streams` output. Rationale: resolves validation AMB-1 of phase-03-videos — user choice in /plan-resolve.
- 2026-10-14 — Thumbnail rule fixed: frame at 10% of the duration, JPEG scaled to max 1280px width (aspect ratio preserved); fallback to frame 0 when extraction at 10% fails. Rationale: resolves validation AMB-2 of phase-03-videos — user choice in /plan-resolve.

---

## TD-04: How the Worker Reads the Source Video

**Scope:** Backend

**Capability:** Transversal — covers: "Processamento automático do vídeo após upload (extração de duração e metadados)", "Geração automática de thumbnail a partir de um frame do vídeo"

**Context:** Files reach 10GB. ffprobe usually needs only the container header (which in MP4 may sit at the *end* of the file — `moov` atom), and the thumbnail needs one seek. How the worker accesses the object drives worker disk sizing, processing time, and robustness. Depends on TD-03 and TD-09.

**Options:**

### Option A: Download the whole object to a temp file, then process locally
- `GetObject` stream → temp file on a worker volume → ffprobe/ffmpeg on the local path → delete.
- **Pros:** Any FFmpeg feature works (full seeking, any container layout). Simplest mental model.
- **Cons:** Up to 10GB of disk per concurrent job and a full 10GB transfer just to read a header and one frame — minutes of I/O per video; worker volume must be sized for `concurrency × 10GB`.

### Option B: Pass a short-lived presigned GET URL as FFmpeg input (HTTP range reads)
- The worker presigns a GET URL against the **internal** storage endpoint and passes it as `-i <url>`. FFmpeg's http protocol issues Range requests, reading only the header/index and the bytes around the seek point.
- **Pros:** Reads megabytes instead of gigabytes; no local disk requirement; works with `moov`-at-end MP4s because HTTP input is seekable. Reuses the same presigning code as TD-11.
- **Cons:** Depends on FFmpeg being built with http(s) protocol support (true for the Debian package, TD-03 A). Network hiccups surface as FFmpeg errors (covered by retries, TD-14). URL TTL must exceed job duration.

### Option C: Pipe the `GetObject` body stream into FFmpeg stdin
- Stream S3 body → `ffprobe -i pipe:0`.
- **Pros:** No disk usage.
- **Cons:** Pipes are not seekable: MP4 files with `moov` at the end fail or force reading the whole stream; seeking to a thumbnail timestamp means consuming the stream up to it. Unreliable for arbitrary user uploads.

**Recommendation:** **Option B (presigned URL as FFmpeg input)** — it is the only option that is both seekable and proportional to what is actually read, so a 10GB upload costs roughly the same processing time as a 100MB one, without sizing worker disks for 10GB per job.

**Decision:** B (Presigned GET URL as FFmpeg input — HTTP range reads)
**Libraries:** @aws-sdk/s3-request-presigner

---

## TD-05: Upload Protocol for Files up to 10GB

**Scope:** Cross-layer

**Capability:** Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance

**Context:** The API must not carry 10GB request bodies, and the project plan's attention points require resuming after connection failure. The protocol defines the handshake between the (future) frontend client, the API and the storage — so it is a backend↔frontend contract even though no UI is built in this phase. Single-request presigned `PUT`/`POST` uploads are capped at **5GB** on AWS S3, so they cannot meet 10GB in production.

**Options:**

### Option A: S3 Multipart Upload with presigned part URLs (direct to storage)
- API calls `CreateMultipartUpload`, returns the `uploadId` and presigned `UploadPart` URLs; the client `PUT`s each part directly to storage and collects ETags; the API finalizes with `CompleteMultipartUpload`. Resume = `ListParts` and re-upload only missing parts.
- **Backend impact:** 3 small JSON endpoints (initiate / sign parts / complete); zero file bytes through Node. **Frontend impact:** client slices the `File` into parts and PUTs them (Uppy's `@uppy/aws-s3` multipart mode or ~100 lines of `fetch`); bucket CORS must expose `ETag`.
- **Pros:** Native S3 protocol (supported by MinIO and every S3-compatible server); up to 10,000 parts × 5GB; parallel parts; resumable per part; the API stays completely out of the data path.
- **Cons:** More orchestration endpoints than a single upload; the client must handle part slicing and ETag collection; requires correct public endpoint + CORS for browser-to-storage requests (TD-09).

### Option B: tus resumable protocol terminated by the API (`@tus/server` + `@tus/s3-store`)
- The API hosts a tus endpoint; the client (`tus-js-client`/Uppy) sends chunks to the API, which streams them into S3 multipart parts.
- **Backend impact:** mount tus server inside Nest/Express, auth hook, `onUploadFinish` hook. **Frontend impact:** standard tus client, very simple.
- **Pros:** Open, well-specified resumable protocol; client libraries handle resume automatically; upload lifecycle hooks in one place.
- **Cons:** All 10GB flows **through the API process** (bandwidth, memory buffers, open connections) — streamed, but it ties API capacity to upload volume, which the capability explicitly asks to avoid. Extra protocol layer and dependencies on top of S3.

### Option C: Single presigned `PUT` (or presigned `POST` policy)
- API presigns one URL; the client uploads the whole file in one request.
- **Pros:** Simplest possible flow — one URL, one request.
- **Cons:** 5GB hard limit on AWS S3 (fails the 10GB requirement in production even if MinIO accepts it locally); no resume — a dropped connection at 9GB restarts from zero.

**Recommendation:** **Option A (S3 multipart with presigned part URLs)** — it is the only option that meets 10GB on real S3, supports resume, and keeps every file byte off the API, which is the core of "sem impacto na performance"; the extra endpoints are small JSON calls the API can serve trivially.

**Decision:** A (S3 Multipart Upload with presigned part URLs)
**Libraries:** @aws-sdk/client-s3, @aws-sdk/s3-request-presigner

**Revisions:**

- 2026-10-14 — Accepted formats: MIME allowlist enforced at upload initiation (`video/mp4`, `video/quicktime`, `video/webm`, `video/x-matroska`; others rejected with 400), plus ffprobe validation in the worker (no valid video stream → fail-fast to `failed`, per TD-14). Rationale: resolves validation AMB-3 of phase-03-videos — user choice in /plan-resolve.

---

## TD-06: Multipart Part Sizing & Part-URL Signing Cadence

**Scope:** Cross-layer

**Capability:** Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance

**Context:** Applies only if TD-05 = A. S3 rules: parts ≥5MiB (except the last), ≤10,000 parts. A 10GB upload on a slow connection can take hours, so presigned part URLs can expire mid-upload. Who decides the part size and when URLs are signed is part of the client↔API contract and of the resume flow.

**Options:**

### Option A: Server-fixed part size, all part URLs signed at initiation
- Client declares file size at initiation; the API computes `partCount` from a configured part size and returns every presigned URL at once.
- **Pros:** One round-trip; simplest client.
- **Cons:** URLs share one TTL — a long upload outlives them, and a resume after expiry has no way to get fresh URLs without a new endpoint anyway. Large responses (hundreds of URLs) for big files.

### Option B: Server-fixed part size, on-demand signing endpoint (batches of part numbers) + resume via `ListParts`
- Initiation returns `uploadId`, `partSize`, `partCount`; the client requests URLs for the part numbers it is about to send (e.g., `POST .../parts` with `[1..N]`), and can ask the API which parts are already stored (`ListParts`) to resume.
- **Pros:** URLs are always fresh (short TTL, better security); resume works at any time; server keeps control of part size and validates part numbers ≤ `partCount`.
- **Cons:** One extra endpoint and more client round-trips (one per batch).

### Option C: Client-chosen part size, server signs whatever part numbers are requested
- **Pros:** Client can tune for its bandwidth.
- **Cons:** Server cannot enforce S3 limits or the 10GB cap via part arithmetic; more validation and edge cases with no benefit for a first-party client.

**Recommendation:** **Option B (server-fixed part size + on-demand signing + `ListParts` resume)** — it is the variant that actually delivers the plan's "retomar em caso de falha" for multi-hour uploads and keeps presigned URLs short-lived; a configurable part size around 100MiB keeps a 10GB file near 100 parts.

**Decision:** B (Server-fixed part size + on-demand signing + `ListParts` resume)

**Revisions:**

- 2026-10-14 — Part-number validation split: `part_numbers` items that are not integers ≥ 1 are rejected by DTO validation as `400 VALIDATION_ERROR` (consistent with the rest of the API); numbers above the video's `part_count` are the domain error `400 INVALID_PART_NUMBER`, since only the service knows `part_count`. Rationale: resolves the contradiction between SI-03.7 acceptance criterion #3 and the Validation Rules found by /plan-test-specs — user choice.

---

## TD-07: Draft Pre-registration & Upload-Completion Trigger

**Scope:** Backend

**Capability:** Transversal — covers: "Pré-cadastro automático do vídeo como rascunho ao iniciar o upload", "Processamento automático do vídeo após upload (extração de duração e metadados)"

**Context:** The video row must exist as a draft when the upload starts, and processing must start automatically once the upload ends. With direct-to-storage uploads (TD-05) the API does not see the bytes, so something must signal "upload finished" and enqueue the job exactly once. Depends on TD-01 and TD-05.

**Options:**

### Option A: Client-driven completion endpoint (API finalizes + enqueues)
- The initiation endpoint creates the draft row and the multipart upload together (storage key + `uploadId` persisted). The client calls a complete endpoint with the part ETags; the API runs `CompleteMultipartUpload`, verifies the object (`HeadObject` size ≤ 10GB), sets status to processing and enqueues with `jobId = videoId` (dedup), all idempotent so the client can safely retry.
- **Pros:** Synchronous, explicit and testable with plain e2e calls; ownership/auth checked on every step; no extra infra; idempotency + deterministic `jobId` cover the "DB updated but enqueue failed" window via client retry.
- **Cons:** If the client never calls complete, the upload is orphaned (draft stays, incomplete multipart must be reclaimed by storage expiry — see TD-14).

### Option B: Storage bucket event notifications
- Configure the storage to emit `s3:ObjectCreated:CompleteMultipartUpload` events (MinIO → webhook/Redis/AMQP; S3 → SQS/EventBridge) that the API or worker consumes to enqueue processing.
- **Pros:** Completion is detected even if the client disappears after the last part (when the client still calls `CompleteMultipartUpload` itself).
- **Cons:** Client must then hold rights to complete the upload (or the API still has to), so the API endpoint does not disappear; notification config differs between MinIO and S3 (non-portable); harder to test deterministically; another moving part in Compose.

### Option C: Worker/scheduler polling storage for finished uploads
- A periodic job lists pending drafts and checks storage for completed objects.
- **Pros:** No client cooperation beyond uploading.
- **Cons:** Latency equal to the poll interval, wasted calls, and a scheduler to own — strictly worse than A for a first-party client.

**Recommendation:** **Option A (client-driven complete endpoint, idempotent, `jobId = videoId`)** — it keeps the flow inside the API's existing auth/validation/error contract, is fully exercisable by supertest e2e against real MinIO/Redis, and the idempotent retry removes the need for an outbox or bucket notifications.

**Decision:** A (Idempotent client-driven complete endpoint, `jobId = videoId`)

**Revisions:**

- 2026-10-14 — Draft title: optional `title` on the initiation request; when omitted, defaults to the original filename without extension. Description and category stay in Phase 04. Rationale: resolves validation AMB-4 of phase-03-videos — user choice in /plan-resolve.

---

## TD-08: Unique Video URL Identifier

**Scope:** Cross-layer

**Capability:** URL única por vídeo, sem conflito com outros vídeos

**Context:** Each video needs a short, unique public identifier that "never conflicts" (project plan attention point). It becomes part of public URLs (future `/watch/<id>` frontend route and `/videos/<id>` API paths), so it is a backend↔frontend contract and must not be enumerable (unlisted visibility in Phase 04 relies on unguessable links). The table already uses UUID PKs (`uuid_generate_v4()`).

**Options:**

### Option A: Short random ID from `node:crypto` (e.g., 11 base64url chars) + UNIQUE constraint + retry on collision
- Generate 8 random bytes → 11-char base64url (≈64 bits, YouTube-like) in a separate `public_id`/`slug` column; on the rare unique violation, regenerate (outside the aborted transaction — see `typeorm-queries.md`).
- **Pros:** No dependency; non-enumerable; short URLs; the DB constraint is the final guarantee of "no conflict"; UUID PK stays internal.
- **Cons:** Needs a collision-retry path (practically never triggered at 64 bits, but must exist and be tested).

### Option B: `nanoid`
- Same idea using the `nanoid` library (configurable alphabet/size).
- **Pros:** Well-known API, custom alphabets.
- **Cons:** nanoid ≥4 is ESM-only while this project compiles to CommonJS (`module: nodenext` without `"type": "module"`) and tests run through ts-jest — adds interop friction for something `crypto.randomBytes` does in one line. Same collision handling still required.

### Option C: Sqids/Hashids encoding of a sequence number
- Encode an auto-increment counter into a short string.
- **Pros:** Collision-free by construction; very short IDs.
- **Cons:** Reversible/enumerable — reveals upload volume and lets anyone walk IDs, undermining future unlisted links; needs a sequence column plus a library.

### Option D: Expose the UUID primary key
- **Pros:** Zero work; globally unique.
- **Cons:** 36-char URLs, not "curta" as the plan asks; couples public URLs to the internal PK.

**Recommendation:** **Option A (11-char base64url from `node:crypto` + UNIQUE + retry)** — short, non-enumerable and dependency-free, with the database constraint as the hard no-conflict guarantee; it avoids nanoid's ESM interop cost and Sqids' enumerability.

**Decision:** A (11-char base64url from `node:crypto` + UNIQUE + retry)

---

## TD-09: Object Storage Layout, Privacy & Endpoints

**Scope:** Cross-layer

**Capability:** Serviço de armazenamento de arquivos (vídeos e thumbnails)

**Context:** Storage is S3-compatible by project definition; what remains open is how it is organized and exposed. Videos must not be publicly listable (drafts, future unlisted). Presigned URLs embed the host they were signed for: inside Docker the API reaches storage at the Compose service name (CLAUDE.md networking rule), but a browser cannot resolve that name — so the URL host handed to clients is a cross-component contract (Joi schema + `.env.example` + `compose.yaml` + presign code + browser CORS).

**Options:**

### Option A: Single private bucket, per-video key prefixes, everything served via presigned URLs
- One bucket (e.g., `streamtube-videos`), keys like `videos/<videoId>/original` and `videos/<videoId>/thumbnail.jpg`; bucket policy private; all reads/writes via presigned URLs.
- **Pros:** One bucket to provision/test; per-video prefix makes cleanup trivial (delete prefix); uniform access control path; no public objects.
- **Cons:** Thumbnails also need presigned (expiring) URLs, so list responses must sign one URL per item (cheap, local HMAC, no network call).

### Option B: Two buckets — private `videos` + public-read `thumbnails`
- **Pros:** Thumbnails get stable, cacheable public URLs with no signing.
- **Cons:** Two buckets to provision; thumbnails of drafts/unlisted videos become publicly fetchable by anyone who guesses keys; visibility rules (Phase 04) would leak through the thumbnail bucket.

### Option C: Single bucket with mixed ACLs (public-read on selected objects)
- **Pros:** Single bucket with public thumbnails.
- **Cons:** Per-object ACLs are discouraged on modern S3 (Object Ownership "bucket owner enforced" disables ACLs by default) and behave differently across S3-compatible servers.

**Recommendation:** **Option A (single private bucket, per-video prefixes, presigned access)** — it keeps one access-control path that Phase 04 visibility rules can extend without leaks. Consequence for the contract: two endpoint settings — an internal endpoint (Compose service name) used for server-side calls, and a public endpoint used only to sign client-facing URLs — plus bucket CORS allowing `PUT`/`GET` from the frontend origin and exposing `ETag` (needed by TD-05 A).

**Decision:** A (Single private bucket, per-video prefixes, presigned access; internal + public endpoints)

**Revisions:**

- 2026-10-14 — In dev and tests the public endpoint is also the Compose service name: `S3_PUBLIC_ENDPOINT=http://minio:9000` (phase spec / CLAUDE.md rule: always the service name, never `localhost`). The two S3 clients stay separate because in production the public endpoint is a different domain. No Phase 03 consumer runs outside a container; to open a presigned URL from the host browser in dev, map `127.0.0.1 minio` in the hosts file (the signature stays valid because the signed host is unchanged). Rationale: compliance with the phase spec's Docker constraint — user choice.

---

## TD-10: Local S3-Compatible Server Image

**Scope:** Repo-wide

**Capability:** Serviço de armazenamento de arquivos (vídeos e thumbnails)

**Context:** The project names "S3 or MinIO" and the challenge expects MinIO locally. However, MinIO stopped publishing Community Edition Docker images and binaries in October 2025 and moved the repository to maintenance mode (later archived) — new images no longer receive updates. The Compose service image must support multipart upload, presigned URLs, CORS and bucket bootstrap reliably, since TD-05/TD-09 depend on them.

**Options:**

### Option A: MinIO — pin the last published Community release image
- Use the final `minio/minio:RELEASE.*` tag (pinned, never `latest`), bucket bootstrap via `mc` (one-shot init container or startup script).
- **Pros:** The reference S3-compatible server, matching the architecture diagram and the challenge expectation; the most complete S3 API compatibility (multipart, presign, CORS) and the widest documentation; dev-only use limits the security exposure of a frozen image.
- **Cons:** Frozen — no further security patches; the image must be pinned by exact tag; the web console was stripped from Community builds before the freeze.

### Option B: SeaweedFS (S3 gateway)
- Actively maintained distributed store with an S3 API; official Docker image.
- **Pros:** Maintained; single-container dev mode available.
- **Cons:** Deviates from the documented "S3 or MinIO" architecture; S3 API coverage (presigned multipart, CORS details) is less battle-tested; more config surface (master/volume/filer).

### Option C: Garage
- Lightweight, actively maintained S3-compatible server (Rust), single binary.
- **Pros:** Small and maintained.
- **Cons:** Deviates from the documented architecture; requires a layout/key initialization step; partial S3 API coverage in areas like presigned-POST/CORS behavior must be verified for this use case.

**Recommendation:** **Option A (pinned last MinIO Community image)** — local development and tests only need a faithful S3 API, which MinIO still provides best, and it matches the project's documented architecture; since production targets AWS S3 (no code change thanks to the S3 SDK), the frozen image is an accepted dev-only risk, to be revisited if a compatibility bug appears.

**Decision:** A (MinIO — pinned last Community release image)
**Libraries:** minio

**Revisions:**

- 2026-10-14 — Image source: the official `minio/minio` (Docker Hub) and `quay.io/minio/minio` repositories no longer allow anonymous pulls, even for dated release tags (verified with `docker pull`: Docker Hub "repository does not exist", Quay `401 UNAUTHORIZED`). Compose pins `bitnamilegacy/minio:2025.7.23-debian-12-r5` (Bitnami's archived build of MinIO RELEASE 2025-07-23, last revision published 2025-08-19); bucket bootstrap via `MINIO_DEFAULT_BUCKETS`. Rationale: Option A not implementable with official images — user choice in /plan-resolve.

---

## TD-11: Byte Delivery for Streaming and Download

**Scope:** Cross-layer

**Capability:** Transversal — covers: "Reprodução via streaming (sem necessidade de download completo)", "Download do vídeo pelo usuário"

**Context:** Playback must start without downloading the whole file (HTTP Range / `206 Partial Content`), and users must be able to download the file. The architecture diagram already draws "Frontend → Object Storage: Streams". The choice decides whether video bytes ever traverse the API and what the frontend puts in `<video src>` / download links. Depends on TD-09.

**Options:**

### Option A: API authorizes, returns a short-lived presigned GET URL; client fetches bytes directly from storage
- `GET /videos/:id/stream` (and `/download`) checks access and returns (or redirects to) a presigned URL; S3/MinIO serve Range requests with `206` natively. Download uses the same mechanism with `ResponseContentDisposition: attachment; filename="..."` in the signed request.
- **Backend impact:** two light endpoints, no byte proxying. **Frontend impact:** `<video src={url}>` and `<a href={url}>`; must refresh the URL if it expires mid-session.
- **Pros:** Matches the architecture diagram; Range/seek/206 handled by storage; zero API bandwidth; same code path for stream and download.
- **Cons:** Expiring URLs (TTL must cover typical viewing; client re-requests on expiry); URL host depends on the public endpoint (TD-09).

### Option B: API proxies bytes with its own Range handling
- API parses `Range`, calls `GetObject` with that range and pipes the body with `206`, `Content-Range`, `Accept-Ranges`.
- **Pros:** Stable, non-expiring URLs on the API domain; fine-grained per-request auth and metrics.
- **Cons:** Every byte of every view crosses the API — the bandwidth/CPU load the phase is designed to avoid; Range parsing edge cases to implement and test; contradicts the diagram.

### Option C: Adaptive streaming (HLS/DASH) transcoded by the worker
- Worker transcodes into segmented renditions + manifest; player uses hls.js.
- **Pros:** Adaptive bitrate, the "real YouTube" experience.
- **Cons:** Heavy transcoding (hours of CPU for long videos), multiple renditions multiply storage, and the capability only requires progressive playback without full download — beyond the phase scope.

**Recommendation:** **Option A (presigned GET from storage, attachment disposition for download)** — it satisfies "sem download completo" through native S3 Range support, keeps video bytes off the API, and is the delivery path already drawn in the architecture; HLS can be a later, separate phase if adaptive bitrate is ever required.

**Decision:** A (Presigned GET from storage; attachment disposition for download)

---

## TD-12: Access Policy for Stream/Download Before Publication Exists

**Scope:** Backend

**Capability:** Transversal — covers: "Reprodução via streaming (sem necessidade de download completo)", "Download do vídeo pelo usuário"

**Context:** The platform lets anonymous users watch, but publication and visibility (public/unlisted, draft → published) only arrive in Phase 04. In Phase 03 every video is, by definition, an unpublished draft. The stream/download endpoints must still decide who may obtain URLs now, and the choice determines the `@Public()` vs guarded decision and the Authorization Matrix of the plan.

**Options:**

### Option A: Owner-only until Phase 04
- Only the authenticated owner of the video's channel can get stream/download URLs (status must be ready). Phase 04 widens access according to visibility/publication.
- **Pros:** No draft ever leaks before a publication concept exists; consistent with Phase 04's "rascunho → publicação" semantics; Phase 04 only *adds* rules instead of revoking a public behavior.
- **Cons:** Anonymous playback (a platform goal) is not demonstrable until Phase 04.

### Option B: Public for any ready video (anonymous, via unguessable ID)
- `@Public()` endpoints; anyone with the ID of a ready video gets URLs.
- **Pros:** Demonstrates anonymous playback now; simpler e2e tests.
- **Cons:** Unpublished drafts become publicly reachable by link; Phase 04 must tighten an already-public endpoint (behavior change for any consumer).

**Recommendation:** **Option A (owner-only until Phase 04)** — every Phase 03 video is a draft, and keeping drafts private now makes Phase 04 a purely additive change (public/unlisted rules) instead of a breaking one.

**Decision:** A (Owner-only until Phase 04)

**Revisions:**

- 2026-10-14 — Phase 03 also exposes an owner-only `GET` for a single video (status, duration, metadata, thumbnail URL) so clients can follow processing; listings / channel panel remain in Phase 04. Rationale: resolves validation AMB-5 of phase-03-videos — user choice in /plan-resolve.

---

## TD-13: Video Status Lifecycle Model

**Scope:** Backend

**Capability:** Transversal — covers: "Pré-cadastro automático do vídeo como rascunho ao iniciar o upload", "Processamento automático do vídeo após upload (extração de duração e metadados)"

**Context:** The phase requires a status cycle reflected in the DB (draft at upload start → processing → ready / error). Phase 04 will introduce publication ("rascunho → publicação") and visibility. If "draft" means both "upload/processing not finished" and "not yet published", the two concepts collide in a single column. This shapes the `videos` migration and enum now.

**Options:**

### Option A: One combined enum covering processing and publication (e.g., `draft | processing | ready | failed | published`)
- **Pros:** Single column, simple queries now.
- **Cons:** A published video can't also express "reprocessing failed"; Phase 04 must redefine `ready` vs `published` semantics on an existing enum; mixes two independent axes.

### Option B: Processing-lifecycle enum only now (`draft → processing → ready | failed`), publication added as an orthogonal field in Phase 04
- `draft` = pre-registered, upload in progress; `processing` = upload completed, job enqueued/running; `ready` = metadata + thumbnail stored; `failed` = terminal processing error (with an error reason column). Phase 04 adds its own publication/visibility field.
- **Pros:** Matches the challenge's cycle literally; each axis evolves independently; no Phase 04 rewrite of Phase 03 states.
- **Cons:** Phase 04 must name its publication field so it isn't confused with processing `draft` (documentation burden).

### Option C: Two columns created now (`processing_status` + `publication_status`)
- **Pros:** Both axes explicit from day one.
- **Cons:** Creates a publication column whose rules belong to Phase 04 — speculative schema outside this phase's capabilities.

**Recommendation:** **Option B (processing-only enum now, publication orthogonal in Phase 04)** — it delivers exactly the required `draft → processing → ready | failed` cycle without inventing Phase 04 rules, and keeps the two axes separable when publication arrives.

**Decision:** B (Processing enum `draft → processing → ready | failed`; publication orthogonal in Phase 04)

**Revisions:**

- 2026-10-14 — Interrupted uploads: while the multipart upload exists the client resumes via `ListParts` (TD-06). Expiry is detected lazily (no scheduler): when an upload operation on a `draft` gets `NoSuchUpload` from storage, the API sets `status = failed` with reason `UPLOAD_EXPIRED`. The owner can then restart the upload (new multipart on the same video, same public ID; `failed` (`UPLOAD_EXPIRED`) → `draft`) or delete the video. Drafts never resumed stay `draft`. Rationale: resolves validation AMB-6 of phase-03-videos — user choice in /plan-resolve.

---

## TD-14: Processing Failure & Retry Policy

**Scope:** Backend

**Capability:** Transversal — covers: "Processamento automático do vídeo após upload (extração de duração e metadados)", "Geração automática de thumbnail a partir de um frame do vídeo"

**Context:** Processing can fail transiently (storage/network blip, worker restart) or permanently (file is not a valid video, no video stream). The policy determines when the video reaches `failed`, what the user sees, and how the worker distinguishes error classes. Depends on TD-01 and TD-13.

**Options:**

### Option A: Automatic retries with exponential backoff for transient errors; fail-fast for invalid media; terminal `failed` + error reason
- Queue job with N attempts + exponential backoff; the processor throws a non-retryable error (BullMQ `UnrecoverableError`) when ffprobe reports invalid/unsupported media; on the final failure the worker sets `status = failed` and stores a short reason. Processor is idempotent (re-running overwrites metadata/thumbnail for the same key).
- **Pros:** Transient failures heal automatically; bad uploads fail in one attempt instead of burning retries; terminal state is visible in the DB as the challenge requires.
- **Cons:** Error classification logic must be written and tested.

### Option B: Option A + a manual "reprocess" endpoint for `failed` videos
- **Pros:** Owner can recover from failures caused by temporary outages longer than the retry window.
- **Cons:** Extra endpoint and state transition (`failed → processing`) not required by any Phase 03 capability.

### Option C: Single attempt, any error → `failed`
- **Pros:** Simplest.
- **Cons:** A Redis/MinIO blip permanently fails a 10GB upload, forcing the user to re-upload everything.

**Recommendation:** **Option A (bounded retries + fail-fast on invalid media + terminal `failed` with reason)** — it covers the failure handling the phase requires without adding a reprocess flow outside the capabilities; orphaned incomplete multipart uploads (client never completes, TD-07) are reclaimed by the storage server's stale-upload expiry rather than by application code.

**Decision:** A (Bounded retries + fail-fast on invalid media + terminal `failed` with reason)

---

## TD-15: Test Strategy for Object Storage and Queue

**Scope:** Backend

**Capability:** Transversal — covers: "Serviço de armazenamento de arquivos (vídeos e thumbnails)", "Serviço de processamento em segundo plano (filas)"

**Context:** The project's testing guide (`testing-guide-nestjs-project/references/external-systems.md`) prescribes a **local filesystem adapter** for storage in dev/tests and a real broker for queues. That predates the direct-to-storage design: presigned multipart URLs (TD-05/06) and presigned GET with Range (TD-04/11) cannot be exercised against a filesystem adapter. The challenge also requires storage/queue/worker to be real Compose services "exercitados pelos testes". The suite currently shares one DB and runs `--runInBand`.

**Options:**

### Option A: Real MinIO + Redis from Compose, test-scoped bucket and queue names
- Integration/e2e tests hit the Compose `storage` and Redis services (service names as hosts), using a dedicated test bucket and a test queue prefix/name, cleaned in `beforeEach`/`afterAll`; worker processing tests use a tiny fixture video (generated with ffmpeg or committed, a few KB).
- **Pros:** Tests the actual S3 contract (presign, multipart, Range, ETag), matching the challenge's "não mocke o que dá para testar de verdade"; mirrors the existing Mailpit/Postgres approach.
- **Cons:** Supersedes part of the testing guide (must be updated in a separate task); tests depend on two more running services.

### Option B: Local filesystem storage adapter (testing guide as written) + real Redis
- **Pros:** Follows the current guide; no storage service needed to run tests.
- **Cons:** Cannot test presigned multipart or range-capable presigned URLs at all — the phase's core flows would be untested or mocked; dual storage implementations to maintain.

### Option C: Testcontainers spinning MinIO/Redis per test run
- **Pros:** Hermetic per-run isolation.
- **Cons:** Requires Docker-in-Docker / Docker socket inside the `nestjs-api` container; diverges from the project's established "Compose services are the test infra" pattern.

**Recommendation:** **Option A (real MinIO + Redis from Compose with test-scoped bucket/queue)** — it is the only option that exercises the S3 presigned/multipart/range contract the phase depends on, and it extends the pattern the suite already uses for Postgres and Mailpit; updating the testing guide's storage section should be tracked as a separate docs task.

**Decision:** A (Real MinIO + Redis from Compose, test-scoped bucket/queue)

**Revisions:**

- 2026-10-14 — Integration/e2e suites fetch presigned URLs (part `PUT`, Range `GET`, download) from inside the `nestjs-api` container. This works without any test-only endpoint override because the public endpoint is the service name `http://minio:9000` (TD-09 revision 2026-10-14); rewriting the URL host after signing is not an option, since the host is part of the SigV4 signature. Rationale: gap found by /plan-test-specs — user choice.
- 2026-10-14 — E2E suites may override a config namespace provider (e.g., `videos` with a tiny `maxSizeBytes`, via `overrideProvider(videosConfig.KEY)`) to reach limits that are infeasible to reproduce for real (a 10GB object for `FILE_TOO_LARGE`); services, repositories, storage and queue stay real — no mocking. Rationale: gap found by /plan-test-specs — user choice.

---

## Canonical env-key set (informative — consequence of TD-01, TD-09, TD-10, TD-15)

Not a decision; listed so `plan-context`/`plan-build` keep Joi schema, `.env.example` and `compose.yaml` consistent. Final names are fixed by the plan.

| Concern | Keys (illustrative) | Note |
|---|---|---|
| Queue (TD-01 A) | `REDIS_HOST=redis`, `REDIS_PORT` | Compose service name as host |
| Storage server-side (TD-09) | `S3_ENDPOINT=http://<storage-service>:9000`, `S3_REGION`, `S3_ACCESS_KEY`, `S3_SECRET_KEY`, `S3_BUCKET`, `S3_FORCE_PATH_STYLE=true` | Internal Compose endpoint |
| Storage client-facing (TD-09) | `S3_PUBLIC_ENDPOINT=http://minio:9000` (dev/test; production = public S3 domain) | Only for signing client-facing URLs; service name per TD-09 revision 2026-10-14 |
| Upload/delivery policy (TD-06, TD-11) | part size, presigned URL TTLs, max upload size (10GB) | Values fixed in the plan |

---

## Decisions Summary

| ID | Scope | Decision | Recommendation | Choice |
|----|-------|----------|---------------|--------|
| TD-01 | Backend | Queue technology | A — BullMQ + Redis (`@nestjs/bullmq`) | A — BullMQ + Redis |
| TD-02 | Backend | Video worker runtime topology | A — same codebase, separate entrypoint + Compose service | A — same codebase, separate entrypoint/container |
| TD-03 | Backend | FFmpeg/ffprobe invocation | A — system binaries (apt) + spawn wrapper | A — apt binaries + spawn wrapper |
| TD-04 | Backend | Worker access to source video | B — presigned URL as FFmpeg input (range reads) | B — presigned URL as FFmpeg input |
| TD-05 | Cross-layer | Upload protocol (10GB) | A — S3 multipart with presigned part URLs | A — S3 multipart, presigned parts |
| TD-06 | Cross-layer | Part sizing & signing cadence | B — server-fixed part size, on-demand signing, `ListParts` resume | B — fixed part size, on-demand signing, ListParts |
| TD-07 | Backend | Draft pre-registration & completion trigger | A — idempotent client-driven complete endpoint, `jobId = videoId` | A — idempotent complete, jobId = videoId |
| TD-08 | Cross-layer | Unique video URL identifier | A — 11-char base64url from `node:crypto` + UNIQUE + retry | A — 11-char base64url + UNIQUE + retry |
| TD-09 | Cross-layer | Storage layout, privacy & endpoints | A — single private bucket, per-video prefixes, internal/public endpoints | A — single private bucket, internal/public endpoints |
| TD-10 | Repo-wide | Local S3-compatible server image | A — pinned last MinIO Community release | A — pinned MinIO Community image |
| TD-11 | Cross-layer | Byte delivery for streaming & download | A — presigned GET from storage (attachment for download) | A — presigned GET (attachment for download) |
| TD-12 | Backend | Stream/download access before publication | A — owner-only until Phase 04 | A — owner-only until Phase 04 |
| TD-13 | Backend | Video status lifecycle model | B — processing enum `draft → processing → ready \| failed`; publication orthogonal in Phase 04 | B — processing enum; publication in Phase 04 |
| TD-14 | Backend | Processing failure & retry policy | A — bounded retries + fail-fast invalid media + terminal `failed` with reason | A — retries + fail-fast + failed with reason |
| TD-15 | Backend | Test strategy for storage & queue | A — real MinIO + Redis from Compose, test-scoped bucket/queue | A — real MinIO + Redis, test-scoped |

## Notes for downstream pipeline

- **Dependencies between TDs:** TD-02 → TD-01; TD-03 → TD-02; TD-04 → TD-03, TD-09; TD-06 applies only if TD-05 = A; TD-07 → TD-01, TD-05; TD-11 → TD-09; TD-14 → TD-01, TD-13; TD-15 → TD-01, TD-10.
- **Out-of-scope follow-ups noted during research (separate tasks, not this phase's TDs):** update `testing-guide-nestjs-project/references/external-systems.md` storage section if TD-15 = A; frontend upload/player UI (future phase consuming TD-05/06/08/11).
- **Sources consulted:** context7 — `/nestjs/bull` (`@nestjs/bullmq` Processor/WorkerHost/registerQueue), `/websites/bullmq_io` (retries/backoff, deduplication, stalled jobs), `/aws/aws-sdk-js-v3` (`getSignedUrl`, multipart `UploadPart`/ETag, custom endpoint, unsigned payload limits), `/websites/deepwiki_timgit_pg-boss` (send options, retry, singletonKey); web — MinIO Community maintenance-mode status (elest.io, itsfoss, pinggy roundups) and `fluent-ffmpeg` npm deprecation notice.
