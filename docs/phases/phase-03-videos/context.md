---
kind: phase
name: phase-03-videos
sources_mtime:
  docs/project-plan.md: "2026-10-14T12:31:15-03:00"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-10-14T19:04:00-03:00"
  docs/decisions/technical-decisions-openapi-docs-nestjs.md: "2026-10-14T12:31:15-03:00"
  docs/phases/phase-01-configuracao-base/context.md: "2026-10-14T12:31:15-03:00"
  docs/phases/phase-02-auth/context.md: "2026-10-14T12:31:15-03:00"
  docs/phases/phase-02-auth-frontend/context.md: "2026-10-14T12:31:15-03:00"
  docs/phases/phase-03-videos/library-refs.md: "2026-10-14T19:05:06-03:00"
  .claude/skills/testing-guide-nestjs-project/SKILL.md: "2026-10-14T12:31:15-03:00"
---

# phase-03-videos — Context

## Scope

**Phase name:** Upload e Processamento de Vídeos

> Upload de arquivos grandes sem travar o sistema, processamento automático do vídeo e geração de URL única.

**Capabilities** (literal, `docs/project-plan.md`):

- Serviço de armazenamento de arquivos (vídeos e thumbnails)
- Serviço de processamento em segundo plano (filas)
- Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance
- Pré-cadastro automático do vídeo como rascunho ao iniciar o upload
- Processamento automático do vídeo após upload (extração de duração e metadados)
- Geração automática de thumbnail a partir de um frame do vídeo
- URL única por vídeo, sem conflito com outros vídeos
- Reprodução via streaming (sem necessidade de download completo)
- Download do vídeo pelo usuário

**Out of scope:** _Not specified._

**Deliverables:** upload de até 10GB funcional, processamento automático do vídeo, streaming funcionando, URLs únicas geradas.

**Affected subprojects:** _None named explicitly for this phase in `docs/project-plan.md`._

**Deferred subprojects:** _None._

**Sequencing notes:** "> Depende de: Fase 01, Fase 02"

**Neighbors (for boundary detection only):**

- **Phase 02:** Fase 02 — Cadastro, Login e Gerenciamento de Conta (Depende de: Fase 01)
- **Phase 04:** Fase 04 — Gerenciamento de Vídeos e Canal (Depende de: Fase 02, Fase 03)

## Decisions Index

| Ref | Source | Scope | Topic | Status | Decision | Libraries |
|-----|--------|-------|-------|--------|----------|-----------|
| phase-03-videos/TD-01 | phase | Backend | Queue Technology (Message Queue "TBD" in the architecture) | decided | A (BullMQ + Redis via `@nestjs/bullmq`) | @nestjs/bullmq, bullmq |
| phase-03-videos/TD-02 | phase | Backend | Video Worker Runtime Topology | decided | A (same codebase, separate worker entrypoint + Compose service) | — |
| phase-03-videos/TD-03 | phase | Backend | FFmpeg / ffprobe Invocation Strategy | decided | A (system ffmpeg/ffprobe + `child_process.spawn` wrapper) | — |
|     └─ Last revision: 2026-10-14 — Thumbnail rule fixed: frame at 10% of the duration, JPEG scaled to max 1280px w… | | | | | | |
| phase-03-videos/TD-04 | phase | Backend | How the Worker Reads the Source Video | decided | B (presigned GET URL as FFmpeg input) | @aws-sdk/s3-request-presigner |
| phase-03-videos/TD-05 | phase | Cross-layer | Upload Protocol for Files up to 10GB | decided | A (S3 Multipart Upload with presigned part URLs) | @aws-sdk/client-s3, @aws-sdk/s3-request-presigner |
|     └─ Last revision: 2026-10-14 — Accepted formats: MIME allowlist enforced at upload initiation (`video/mp4`, `vi… | | | | | | |
| phase-03-videos/TD-06 | phase | Cross-layer | Multipart Part Sizing & Part-URL Signing Cadence | decided | B (server-fixed part size + on-demand signing + `ListParts` resume) | — |
| phase-03-videos/TD-07 | phase | Backend | Draft Pre-registration & Upload-Completion Trigger | decided | A (idempotent client-driven complete endpoint, `jobId = videoId`) | — |
|     └─ Last revision: 2026-10-14 — Draft title: optional `title` on the initiation request; when omitted, defaults… | | | | | | |
| phase-03-videos/TD-08 | phase | Cross-layer | Unique Video URL Identifier | decided | A (11-char base64url from `node:crypto` + UNIQUE + retry) | — |
| phase-03-videos/TD-09 | phase | Cross-layer | Object Storage Layout, Privacy & Endpoints | decided | A (single private bucket, per-video prefixes, presigned access) | — |
| phase-03-videos/TD-10 | phase | Repo-wide | Local S3-Compatible Server Image | decided | A (MinIO, pinned last Community release image) | minio |
|     └─ Last revision: 2026-10-14 — Image source: the official `minio/minio` (Docker Hub) and `quay.io/minio/minio`… | | | | | | |
| phase-03-videos/TD-11 | phase | Cross-layer | Byte Delivery for Streaming and Download | decided | A (presigned GET; attachment disposition for download) | — |
| phase-03-videos/TD-12 | phase | Backend | Access Policy for Stream/Download Before Publication Exists | decided | A (owner-only until Phase 04) | — |
|     └─ Last revision: 2026-10-14 — Phase 03 also exposes an owner-only `GET` for a single video (status, duration,… | | | | | | |
| phase-03-videos/TD-13 | phase | Backend | Video Status Lifecycle Model | decided | B (enum `draft → processing → ready \| failed`; publication orthogonal) | — |
|     └─ Last revision: 2026-10-14 — Interrupted uploads: while the multipart upload exists the client resumes via `… | | | | | | |
| phase-03-videos/TD-14 | phase | Backend | Processing Failure & Retry Policy | decided | A (bounded retries + fail-fast on invalid media + terminal `failed`) | — |
| phase-03-videos/TD-15 | phase | Backend | Test Strategy for Object Storage and Queue | decided | A (real MinIO + Redis from Compose, test-scoped bucket/queue) | — |

_Source files:_

- phase-03-videos — `docs/decisions/technical-decisions-phase-03-videos.md` (scope_type: phase, related_phases: [3])

## Capability Coverage

| Capability (from project-plan.md) | Covered by |
|-----------------------------------|------------|
| Serviço de armazenamento de arquivos (vídeos e thumbnails) | phase-03-videos/TD-09, phase-03-videos/TD-10, phase-03-videos/TD-15 |
| Serviço de processamento em segundo plano (filas) | phase-03-videos/TD-01, phase-03-videos/TD-02, phase-03-videos/TD-15 |
| Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance | phase-03-videos/TD-05, phase-03-videos/TD-06 |
| Pré-cadastro automático do vídeo como rascunho ao iniciar o upload | phase-03-videos/TD-07, phase-03-videos/TD-13 |
| Processamento automático do vídeo após upload (extração de duração e metadados) | phase-03-videos/TD-02, phase-03-videos/TD-03, phase-03-videos/TD-04, phase-03-videos/TD-07, phase-03-videos/TD-13, phase-03-videos/TD-14 |
| Geração automática de thumbnail a partir de um frame do vídeo | phase-03-videos/TD-03, phase-03-videos/TD-04, phase-03-videos/TD-14 |
| URL única por vídeo, sem conflito com outros vídeos | phase-03-videos/TD-08 |
| Reprodução via streaming (sem necessidade de download completo) | phase-03-videos/TD-11, phase-03-videos/TD-12 |
| Download do vídeo pelo usuário | phase-03-videos/TD-11, phase-03-videos/TD-12 |

## Decisions Detail

### phase-03-videos/TD-01

**Recommendation:** It is the only option where retries, backoff, per-video dedup and stalled-job recovery are job options instead of hand-built topology, it has an official NestJS integration the project's skills already target, and the cost (one small Redis service) is lower than RabbitMQ's; pg-boss's transactional enqueue is attractive but the idempotent "complete" flow in TD-07 already removes the lost-job risk without coupling the queue to the app database.
**Libraries:** @nestjs/bullmq, bullmq

### phase-03-videos/TD-02

**Recommendation:** Gives the process/CPU isolation the architecture requires while keeping a single schema source and a single DoD pipeline; installing `ffmpeg` in the shared dev image (so worker integration tests run in the same container as the rest of the suite) is a one-line Dockerfile change.
**Libraries:** —

### phase-03-videos/TD-03

**Recommendation:** Docker already defines the runtime, so the OS package is the most reliable source of the binary; it avoids an unmaintained wrapper (B) and the bind-mounted `node_modules` platform pitfalls of static npm binaries (C).
**Libraries:** —

**Revisions:**
- 2026-10-14 — Metadata contract fixed: typed columns for the essentials (`duration_seconds`, `width`, `height`, `video_codec`, `size_bytes`) plus a JSONB `metadata` column holding the summarized ffprobe `format`/`streams` output. Rationale: resolves validation AMB-1 of phase-03-videos — user choice in /plan-resolve.
- 2026-10-14 — Thumbnail rule fixed: frame at 10% of the duration, JPEG scaled to max 1280px width (aspect ratio preserved); fallback to frame 0 when extraction at 10% fails. Rationale: resolves validation AMB-2 of phase-03-videos — user choice in /plan-resolve.

### phase-03-videos/TD-04

**Recommendation:** It is the only option that is both seekable and proportional to what is actually read, so a 10GB upload costs roughly the same processing time as a 100MB one, without sizing worker disks for 10GB per job.
**Libraries:** @aws-sdk/s3-request-presigner

### phase-03-videos/TD-05

**Recommendation:** It is the only option that meets 10GB on real S3, supports resume, and keeps every file byte off the API, which is the core of "sem impacto na performance"; the extra endpoints are small JSON calls the API can serve trivially.
**Libraries:** @aws-sdk/client-s3, @aws-sdk/s3-request-presigner

**Revisions:**
- 2026-10-14 — Accepted formats: MIME allowlist enforced at upload initiation (`video/mp4`, `video/quicktime`, `video/webm`, `video/x-matroska`; others rejected with 400), plus ffprobe validation in the worker (no valid video stream → fail-fast to `failed`, per TD-14). Rationale: resolves validation AMB-3 of phase-03-videos — user choice in /plan-resolve.

### phase-03-videos/TD-06

**Recommendation:** It is the variant that actually delivers the plan's "retomar em caso de falha" for multi-hour uploads and keeps presigned URLs short-lived; a configurable part size around 100MiB keeps a 10GB file near 100 parts.
**Libraries:** —

**Revisions:**
- 2026-10-14 — Part-number validation split: `part_numbers` items that are not integers ≥ 1 are rejected by DTO validation as `400 VALIDATION_ERROR` (consistent with the rest of the API); numbers above the video's `part_count` are the domain error `400 INVALID_PART_NUMBER`, since only the service knows `part_count`. Rationale: resolves the contradiction between SI-03.7 acceptance criterion #3 and the Validation Rules found by /plan-test-specs — user choice.

### phase-03-videos/TD-07

**Recommendation:** It keeps the flow inside the API's existing auth/validation/error contract, is fully exercisable by supertest e2e against real MinIO/Redis, and the idempotent retry removes the need for an outbox or bucket notifications.
**Libraries:** —

**Revisions:**
- 2026-10-14 — Draft title: optional `title` on the initiation request; when omitted, defaults to the original filename without extension. Description and category stay in Phase 04. Rationale: resolves validation AMB-4 of phase-03-videos — user choice in /plan-resolve.

### phase-03-videos/TD-08

**Recommendation:** Short, non-enumerable and dependency-free, with the database constraint as the hard no-conflict guarantee; it avoids nanoid's ESM interop cost and Sqids' enumerability.
**Libraries:** —

### phase-03-videos/TD-09

**Recommendation:** It keeps one access-control path that Phase 04 visibility rules can extend without leaks. Consequence for the contract: two endpoint settings — an internal endpoint (Compose service name) used for server-side calls, and a public endpoint used only to sign client-facing URLs — plus bucket CORS allowing `PUT`/`GET` from the frontend origin and exposing `ETag` (needed by TD-05 A).
**Libraries:** —

**Revisions:**
- 2026-10-14 — In dev and tests the public endpoint is also the Compose service name: `S3_PUBLIC_ENDPOINT=http://minio:9000` (phase spec / CLAUDE.md rule: always the service name, never `localhost`). The two S3 clients stay separate because in production the public endpoint is a different domain. No Phase 03 consumer runs outside a container; to open a presigned URL from the host browser in dev, map `127.0.0.1 minio` in the hosts file (the signature stays valid because the signed host is unchanged). Rationale: compliance with the phase spec's Docker constraint — user choice.

### phase-03-videos/TD-10

**Recommendation:** Local development and tests only need a faithful S3 API, which MinIO still provides best, and it matches the project's documented architecture; since production targets AWS S3 (no code change thanks to the S3 SDK), the frozen image is an accepted dev-only risk, to be revisited if a compatibility bug appears.
**Libraries:** minio

**Revisions:**
- 2026-10-14 — Image source: the official `minio/minio` (Docker Hub) and `quay.io/minio/minio` repositories no longer allow anonymous pulls, even for dated release tags (verified with `docker pull`: Docker Hub "repository does not exist", Quay `401 UNAUTHORIZED`). Compose pins `bitnamilegacy/minio:2025.7.23-debian-12-r5` (Bitnami's archived build of MinIO RELEASE 2025-07-23, last revision published 2025-08-19); bucket bootstrap via `MINIO_DEFAULT_BUCKETS`. Rationale: Option A not implementable with official images — user choice in /plan-resolve.

### phase-03-videos/TD-11

**Recommendation:** It satisfies "sem download completo" through native S3 Range support, keeps video bytes off the API, and is the delivery path already drawn in the architecture; HLS can be a later, separate phase if adaptive bitrate is ever required.
**Libraries:** —

### phase-03-videos/TD-12

**Recommendation:** Every Phase 03 video is a draft, and keeping drafts private now makes Phase 04 a purely additive change (public/unlisted rules) instead of a breaking one.
**Libraries:** —

**Revisions:**
- 2026-10-14 — Phase 03 also exposes an owner-only `GET` for a single video (status, duration, metadata, thumbnail URL) so clients can follow processing; listings / channel panel remain in Phase 04. Rationale: resolves validation AMB-5 of phase-03-videos — user choice in /plan-resolve.

### phase-03-videos/TD-13

**Recommendation:** It delivers exactly the required `draft → processing → ready | failed` cycle without inventing Phase 04 rules, and keeps the two axes separable when publication arrives.
**Libraries:** —

**Revisions:**
- 2026-10-14 — Interrupted uploads: while the multipart upload exists the client resumes via `ListParts` (TD-06). Expiry is detected lazily (no scheduler): when an upload operation on a `draft` gets `NoSuchUpload` from storage, the API sets `status = failed` with reason `UPLOAD_EXPIRED`. The owner can then restart the upload (new multipart on the same video, same public ID; `failed` (`UPLOAD_EXPIRED`) → `draft`) or delete the video. Drafts never resumed stay `draft`. Rationale: resolves validation AMB-6 of phase-03-videos — user choice in /plan-resolve.

### phase-03-videos/TD-14

**Recommendation:** It covers the failure handling the phase requires without adding a reprocess flow outside the capabilities; orphaned incomplete multipart uploads (client never completes, TD-07) are reclaimed by the storage server's stale-upload expiry rather than by application code.
**Libraries:** —

### phase-03-videos/TD-15

**Recommendation:** It is the only option that exercises the S3 presigned/multipart/range contract the phase depends on, and it extends the pattern the suite already uses for Postgres and Mailpit; updating the testing guide's storage section should be tracked as a separate docs task.
**Libraries:** —

**Revisions:**
- 2026-10-14 — Integration/e2e suites fetch presigned URLs (part `PUT`, Range `GET`, download) from inside the `nestjs-api` container. This works without any test-only endpoint override because the public endpoint is the service name `http://minio:9000` (TD-09 revision 2026-10-14); rewriting the URL host after signing is not an option, since the host is part of the SigV4 signature. Rationale: gap found by /plan-test-specs — user choice.
- 2026-10-14 — E2E suites may override a config namespace provider (e.g., `videos` with a tiny `maxSizeBytes`, via `overrideProvider(videosConfig.KEY)`) to reach limits that are infeasible to reproduce for real (a 10GB object for `FILE_TOO_LARGE`); services, repositories, storage and queue stay real — no mocking. Rationale: gap found by /plan-test-specs — user choice.

## Inherited Decisions Detail

### phase-01-configuracao-base/TD-01

**Recommendation:** Option A (@nestjs/config) — Official, core-team-maintained, guaranteed NestJS 11 compatibility. The `registerAs()` factory pattern solves the TypeORM CLI sharing problem: the factory function can be imported as a plain function by `data-source.ts` while also serving as a DI injection token inside NestJS. Building a custom module recreates solved functionality; third-party packages carry maintenance risk.

**Libraries:** `@nestjs/config@^4.x`

### phase-01-configuracao-base/TD-02

**Recommendation:** Option A (Joi) — First-class integration with `@nestjs/config` via `validationSchema`, requiring zero custom wiring. Handles string-to-number coercion natively. Using a different tool for env validation vs. request validation is reasonable — env config is validated once at startup, DTOs are validated per-request. Zod is elegant but adds a third validation paradigm to the project.

**Libraries:** `joi@^17.x`

### phase-01-configuracao-base/TD-03

**Recommendation:** Option B (Namespaced/grouped with registerAs) — The project roadmap explicitly calls for auth, email, and storage in upcoming phases. Namespaced configs provide clear file boundaries per domain, typed injection via `ConfigType<typeof databaseConfig>`, and natural scalability. The `registerAs()` factory is dual-purpose: DI token inside NestJS and plain importable function for `data-source.ts`. Initial files for Phase 01: `src/config/database.config.ts`, `src/config/app.config.ts`.

**Libraries:** —

### phase-01-configuracao-base/TD-04

**Recommendation:** Option A (Shared registerAs factory) — Natural outcome of choosing `@nestjs/config` with `registerAs`. The factory is already callable by design. `data-source.ts` imports it, calls `dotenv.config()`, then calls the factory. Zero duplication, minimal code, no extra abstraction.

**Libraries:** `dotenv` (transitive via `@nestjs/config`)

### phase-02-auth/TD-01

**Recommendation:** Argon2id — For a greenfield project in 2026, Argon2id is the OWASP-recommended choice. The native build dependency is a one-time Docker setup cost. The project has no legacy constraints favoring bcrypt. OWASP minimum: 19MiB memory, 2 iterations.

**Libraries:** `argon2@^0.41.x`

### phase-02-auth/TD-02

**Recommendation:** Option A (@nestjs/passport) — The project plan includes only email/password auth for now, but the plugin architecture costs little and future phases may add social login. Aligns with official NestJS docs, making onboarding and maintenance easier.

**Note:** Decision deliberately diverged from the Recommendation during implementation — custom guards were preferred over `@nestjs/passport` to keep the dependency surface smaller; social login is not on the near-term roadmap, so the plugin-architecture benefit did not justify the extra abstraction layer.

**Libraries:** `@nestjs/jwt@^11.0.0`

### phase-02-auth/TD-03

**Recommendation:** Option A (Refresh Token Rotation) — Provides the strongest security model with automatic theft detection. The DB write overhead is acceptable for a video platform (auth refresh is infrequent vs. video operations). PostgreSQL is already in the stack, so no new infrastructure needed. Race conditions can be mitigated with a short grace period for the old token.

**Libraries:** —

### phase-02-auth/TD-04

**Recommendation:** Option B (Random Opaque Tokens in DB) — Revocability is important: when a user requests a new password reset, previous tokens should be invalidated. The DB table is trivial to implement, and the tokens table can also serve future needs (e.g., API keys). Keeps email tokens decoupled from the JWT auth system.

**Libraries:** —

### phase-02-auth/TD-05

**Recommendation:** Option A (@nestjs-modules/mailer) — Best NestJS integration with minimal boilerplate. Supports SMTP (matching the architecture diagram), works with MailHog/Mailpit for local development without external dependencies, and scales to any SMTP provider in production. Template engine support (Handlebars) simplifies email formatting. No vendor lock-in.

**Libraries:** `@nestjs-modules/mailer@^2.x`, `handlebars@^4.x`

### phase-02-auth/TD-06

**Recommendation:** Option A (class-validator + class-transformer) — This is a backend-only project (no shared schemas with frontend), so Zod's single-source-of-truth advantage is less impactful. class-validator is the documented NestJS approach, and the project already uses decorators extensively (TypeORM entities, NestJS DI). Fewer integration surprises with NestJS 11.

**Libraries:** `class-validator@^0.14.x`, `class-transformer@^0.5.x`

### phase-02-auth/TD-07

**Recommendation:** Option A (Custom Domain Exception Filter) — Provides machine-readable error codes that the Next.js frontend can switch on, without the overhead of RFC 9457's URI-based type system. The project is single-consumer (first-party frontend), so a simple `{ statusCode, error, message }` format with domain codes balances clarity and simplicity. The custom filter cost is low — two small files.

**Libraries:** —

### phase-02-auth/TD-08

**Recommendation:** Option A (@nestjs/throttler) — Native NestJS integration is decisive: the guard system allows scoping rate limiting to `AuthModule` only via module-level `APP_GUARD`, with `@SkipThrottle()` for exemptions. The project is single-instance with no distributed requirements, so in-memory storage is sufficient. Using express-rate-limit would bypass NestJS's DI and guard lifecycle for no clear benefit.

**Libraries:** `@nestjs/throttler@^6.x`

### phase-02-auth/TD-09

**Recommendation:** Option B (Opaque) — Since DB lookup is mandatory (TD-03), JWT signature adds no security value. Opaque tokens are shorter, leak no data, and are simpler to generate.

**Note:** Decision deliberately diverged from the Recommendation — JWT was kept to reuse the access-token signing/verification infrastructure (`@nestjs/jwt`), trading token size and base64-readability for a single token format across the codebase.

**Libraries:** `@nestjs/jwt@^11.0.0`

### phase-02-auth/TD-10

**Recommendation:** Option A — The platform is a video sharing service with URL-based channel handles. A strict `[a-z0-9_]` allowlist is the simplest and most portable choice: no extra dependencies, no edge cases around hyphen positioning, and the `user_<random>` fallback provides a valid handle even for extreme email prefixes. Hyphens can always be added in a future iteration if user feedback justifies it.

**Libraries:** —

### phase-02-auth-frontend/TD-01

**Recommendation:** Three reasons. (1) **Architectural fit.** The strict-BFF model in `next-frontend-config-base/TD-03` already nominates the Route Handler as the only NestJS caller; cookie-based sessions are the natural match, and Auth.js's framework adds layers between the BFF and the cookie that buy nothing because the backend is the auth authority — Auth.js's value (DB adapters, OAuth providers, magic-link, `getServerSession` helpers) is mostly unused in this configuration. (2) **Smaller blast radius.** A ~50-LOC session helper is grep-friendly, debuggable, and test-friendly via the existing MSW+BFF integration test pattern; a misconfigured Auth.js callback is a longer fault-isolation loop. (3) **Compatibility with Next.js 16 / React 19.** Built-in `next/headers` `cookies()` is the canonical primitive both runtimes already use; Auth.js v5 versions track Next.js majors with a lag, adding compatibility risk that Option A does not have. Option C is rejected as unsafe (`localStorage` for refresh tokens) and architecturally regressive (loses RSC personalization).

**Libraries:** —

### phase-02-auth-frontend/TD-02

**Recommendation:** Three reasons. (1) **Defense in depth on the cookie content** — `httpOnly` blocks JS, encryption blocks accidental log/proxy inspection; the marginal cost is one ~3KB dep. (2) **Single cookie to manage** simplifies logout (one `session.destroy()` call) and avoids the orphan-cookie failure mode of Option A. (3) **Room to carry minimal user metadata** (`userId`, `email`, `channelSlug`) lets `app/layout.tsx` RSC render the authenticated chrome (avatar, channel name) without a per-render `/auth/me` round-trip — Phase 04+ gains compound here. Option A is a viable downgrade if the team rejects `iron-session` for any reason; the migration A→B (or B→A) is a one-Route-Handler refactor with no test changes downstream because the BFF interface is unchanged. Option C is rejected: it solves a problem (server-side revocation) the project does not have at the cost of infrastructure the project does not own.

**Libraries:** iron-session

### phase-02-auth-frontend/TD-03

**Recommendation:** The single-flight detail is non-trivial and goes in the helper from day one — tested by MSW with a "two concurrent intercepted upstream calls; one refresh expected" assertion. Option B's client-driven pattern is rejected because it doesn't replace Option A (RSC still needs server-side refresh) — adopting B means doing both. Option C's pre-emptive timer is rejected because the failure modes (multiple tabs, sleep/wake) outweigh the latency saving and force a `"use client"` shell near the root.

**Libraries:** —

### phase-02-auth-frontend/TD-04

**Recommendation:** Three reasons. (1) **Decoupled from TD-05** — works with Route Handlers OR Server Actions; the form code does not change if TD-05 is revisited later. (2) **Aligned with shadcn's canonical form primitive** — the project already commits to `radix-nova` shadcn (`components.json`); `npx shadcn@latest add form` produces react-hook-form wrappers; choosing react-hook-form means using the supported primitive instead of hand-rolling around it. (3) **Zod-first developer ergonomics match the rest of the FE foundation** — `next-frontend-config-base/TD-01` chose Zod 4 for env; the same schemas-as-source-of-truth pattern carries to forms with zero new validator paradigm. Option B is rejected for impedance with shadcn's primitive and for over-investing in progressive-enhancement that the strict-BFF model does not require. Option C is rejected for the per-field boilerplate and the loss of client-side feedback on a project that values quick, type-safe form iteration.

**Libraries:** react-hook-form, @hookform/resolvers

### phase-02-auth-frontend/TD-05

**Recommendation:** Three reasons. (1) **Strict-BFF alignment.** `next-frontend-config-base/TD-03` named Route Handlers as the BFF surface; Option A keeps every mutation visible under `app/api/**`. (2) **Test scaffold already exists** — `next-frontend/CLAUDE.md` § Testing and `next-frontend-msw-foundation` were authored for Route-Handlers-as-functions; Option A reuses them with zero invention. (3) **Single mutation surface** — Phase 02 sets the precedent for Phases 03–07; uniformity beats per-mutation idiom-picking when the cost of inconsistency compounds (Option C). Option B has real ergonomic appeal for the simplest forms but fragments the BFF surface and forces test-pattern reinvention; if the team later wants progressive enhancement for specific forms, the migration A→B is per-form and doesn't require touching unrelated routes — A is the safer default and the cheaper baseline.

**Libraries:** —

### phase-02-auth-frontend/TD-06

**Recommendation:** Two reinforcing reasons. (1) **No first-render flicker, no round-trip** — the session is delivered in the same response as the page HTML; the Client Provider hydrates with the correct initial state; users never see "Login" briefly turn into their avatar. (2) **No new BFF endpoint** — the cookie is the source of truth, RSC reads it, the Provider broadcasts it; the BFF surface stays minimal. The `router.refresh()` requirement after mid-session mutations is a small price (one line in the relevant mutation handler) for the structural benefits. Option B is rejected for the double-read-and-flicker; Option C is dominated by Option B and rejected.

**Libraries:** —

### phase-02-auth-frontend/TD-07

**Recommendation:** Three reasons. (1) **First-paint-correct** — the user sees the right outcome on the first paint, no skeleton, no flicker. (2) **Single integration pattern across both flows** — confirmation is RSC-only; reset is RSC + Client form (TD-04, TD-05 patterns reused) — both share the "RSC owns the token, Client Component owns the input" split. (3) **Email-prefetch behavior** is solved at the backend's idempotent-confirmation level (a small note for `/plan-build` to confirm; not a separate TD). Option B's Route-Handler-as-link-target adds redirects for no clean gain. Option C is dominated.

**Libraries:** —

### openapi-docs-nestjs/TD-01

**Recommendation:** **Option A (`@nestjs/swagger`)** — é a única opção que preserva as decisões anteriores (`class-validator` em TD-06 de phase-02-auth) sem re-platform; o CLI plugin com `classValidatorShim: true` aproveita os decoradores `class-validator` existentes para inferir schemas, mantendo o boilerplate baixo. Nestia tem mérito técnico real mas o custo de migração do stack de validação inviabiliza-a sem uma decisão upstream de supersede de TD-06. Manual authoring é descartado.

**Libraries:** @nestjs/swagger

**Revisions:**

- 2026-05-12 — Esclarece que o CLI plugin (`classValidatorShim: true`) cobre apenas inferência de schemas de DTOs a partir de `class-validator`; documentação de operações, respostas tipadas por status code, contratos de erro (alinhados ao envelope de phase-02-auth/TD-07) e exemplos exigem decoradores explícitos (`@ApiOperation`, `@ApiResponse`, `@ApiBody`, `@ApiParam`, `@ApiQuery`, `@ApiExtraModels`). _Rationale:_ openapi.json gerado pelo bootstrap atual está genérico — sem detalhes de parâmetros, schemas de retorno por status, nem contratos de erro — porque a base instalada se apoiou só na introspecção automática. Esta revisão fixa que enriquecimento via decoradores explícitos faz parte da Option A escolhida, não é trabalho fora do escopo do TD.

### openapi-docs-nestjs/TD-02

**Recommendation:** **Option C (Ambos)** — o custo marginal sobre Option A é apenas um npm script (~15 linhas) e o benefício é uma fundação correta para futura integração FE (codegen offline) sem perder a UI interativa que dev/QA usam. Option B sozinho pune a experiência de desenvolvimento em dev/local; Option A sozinho compromete o pipeline de codegen futuro. Combinar é dominante.

**Libraries:** —

### openapi-docs-nestjs/TD-03

**Recommendation:** **Option B (Apenas em dev/staging)** — alinha com a postura defensiva já estabelecida em phase 02 e não compromete consumidores legítimos (o `openapi.json` commitado em TD-02 cumpre o papel de "spec consultável fora da UI"). Re-abrir como Option A ou C é trivial no futuro se um caso de uso de API pública aparecer.

**Libraries:** —

## Inherited Conventions

- Backend config uses `@nestjs/config` with namespaced `registerAs(name, () => ({...}))` factories — one file per domain in `src/config/`. _(from phase 01)_
- Env variables are validated by a Joi schema in `src/config/env.validation.ts`, passed to `ConfigModule.forRoot({ validationSchema, ... _(from phase 01)_
- Config is injected into modules via `ConfigType<typeof xxxConfig>` and `@Inject(xxxConfig.KEY)`; the same factory is importable as a plain... _(from phase 01)_
- `data-source.ts` loads `.env` via `import 'dotenv/config'` at the top, then imports `databaseConfig` and calls it as a plain function. _(from phase 01)_
- Database connection parameters (host, port, etc.) are sourced from a single `databaseConfig` factory — never duplicated between `AppModule` and... _(from phase 01)_
- `TypeOrmModule.forRootAsync` is used (not `forRoot`), with `imports: [ConfigModule]`, `inject: [databaseConfig.KEY]`, `useFactory` returning options... _(from phase 01)_

## Inherited Deferred Capabilities

| Capability | Status | Origin phase | Rationale |
|-----------|--------|--------------|-----------|
| Telas de frontend | deferred | phase-01-configuracao-base | `next-frontend/` is not initialized in this phase; UI surfaces start in a later phase. |
| Telas de cadastro, login, confirmação de conta e recuperação de senha | deferred | phase-02-auth | `next-frontend/` is not initialized in this phase; UI surfaces start in a later phase. |
| "Confirmação de conta via e-mail com link de ativação" | deferred | phase-02-auth-frontend | deferred_to_next_phase — UI landing screen de-scoped 2026-05-14; FE confirmation flow (TD-07) picked up by a future phase. BE side unchanged in `phase-02-auth`. |
| "Logout" | deferred | phase-02-auth-frontend | deferred_to_next_phase — logout button lives inside authenticated chrome (typically Phase 04). Phase 02 still implements POST `/api/auth/logout` (BFF route handler + `session.destroy()`) so the contract is ready when the chrome lands. |
| "Recuperação de senha (destination screen / set-new-password)" | deferred | phase-02-auth-frontend | deferred_to_next_phase — `/forgot-password` ships this phase sending the e-mail; the reset-password destination screen is absent from Figma → link destination remains a 404 until a later phase delivers the screen via `/screen-inventory` extension run. Documented as a known gap. |
| "Telas de cadastro, login, confirmação de conta e recuperação de senha" | deferred | phase-02-auth-frontend | a tela de confirmação da conta não será implementada nesta fase corrente, será adiada — the umbrella bullet's full coverage requires the confirmação and reset-password destination screens; both are deferred per Non-UI rows above. The 3 ship-this-phase telas (signup, login, forgot-password) are inventoried and covered by their own verbs; the umbrella bullet itself is deferred to the phase that lands the missing screens. |

## Non-UI / Deferred Capabilities

_None._

## Testing Requirements

### nestjs-project

_(from `testing-guide-nestjs-project` — §3 Feature Implementation Checklist; queue-processor row from `artifacts/future-types.md`)_

| Artifact type | Required layers |
|---------------|-----------------|
| Entity (`*.entity.ts`) | Integration: constraints, defaults, `select: false` |
| Service with branching + DB | Unit: branch logic (mock repo) + Integration: DB contract |
| Service with DB only (no branching) | Integration: DB contract |
| Service with configured lib (JWT, cache) | Unit: real lib with test config |
| Service with side-effect dep (email, storage) | Integration: real capture service (Mailpit) or local adapter |
| Module with configured imports | Unit: compilation test |
| Controller | E2E only — do NOT write unit tests |
| DTO | E2E: one validation wiring test per endpoint |
| Guard (delegates to service for business logic) | E2E + Unit if complex internal logic |
| Guard (simple, delegates to Passport) | E2E only |
| Pipe (custom transformation/validation) | Unit |
| Interceptor (response transform, logging) | Unit and/or E2E |
| Exception Filter | Unit + E2E |
| Middleware | E2E |
| Queue consumer / processor with business logic | Unit (mock deps) + Integration (real DB/storage) |
| Queue consumer / processor with only external system calls | Integration (real systems) |

### next-frontend

_Not in scope for this phase — no frontend work in Phase 03._
