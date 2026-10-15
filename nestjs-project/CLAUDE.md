# CLAUDE.md

## Environment Startup Verification

**Default behavior:** starting the environment means starting **only infrastructure services** (database, mail, etc.) — **never** start the NestJS application server unless the user explicitly asks to run/serve the project (e.g., "rode o projeto", "suba o servidor", "run the app").

After starting infrastructure, always confirm the containers are up before proceeding:

```bash
docker compose ps   # all services must show status "running"
```

Then verify each infrastructure service is actually ready to accept connections — not just running:

- **PostgreSQL:** `docker compose exec db pg_isready -U streamtube` — expect `accepting connections`
- **Redis:** `docker compose exec redis redis-cli ping` — expect `PONG`
- **MinIO:** `docker compose exec minio curl -f http://minio:9000/minio/health/live` — expect exit code 0 (the host is the Compose service name, never `localhost`)
- **Video worker:** `docker compose logs video-worker` — expect `Video worker started`; the worker has no port, so there is nothing to `curl`

Only start the NestJS dev server (`npm run start:dev`) when the user **explicitly** asks to run the application — never as part of "start the environment". The `video-worker` service is part of the infrastructure (it starts with `docker compose up -d`): it only consumes the `video-processing` queue and exposes no HTTP port.

## Development Environment

This project runs inside Docker. Always use the container for development:

```bash
# Start containers
docker compose up -d

# Install dependencies (first time only)
docker compose exec nestjs-api npm install

# Run the dev server (watch mode)
docker compose exec nestjs-api npm run start:dev
```

Services:
- `nestjs-api` — NestJS API, port `3000`
- `db` — PostgreSQL 17, port `5432`, database `streamtube`, user/password `streamtube`
- `mailpit` — SMTP sink for account e-mails, SMTP `1025`, web UI `8025`
- `redis` — Redis 8 (`maxmemory-policy noeviction`, required by BullMQ), bound to `127.0.0.1:6379`
- `minio` — S3-compatible object storage, API `127.0.0.1:9000`, console `127.0.0.1:9001`; buckets `streamtube-videos` (app) and `streamtube-videos-test` (test suites, set by `src/test/setup-test-env.ts`) are created at startup
- `video-worker` — same image and bind mount as `nestjs-api`, runs `npm run start:worker:dev`; consumes the `video-processing` queue (ffprobe/ffmpeg are installed in the shared image); no published ports

All verification and teardown commands run on the **host machine**:

```bash
# Verify NestJS is running (expect 200 + "Hello World!")
curl http://localhost:3000

# Verify PostgreSQL is ready (runs inside the db container)
docker compose exec db pg_isready -U streamtube

# Check container logs
docker compose logs nestjs-api
docker compose logs db

# Tear down the entire environment
docker compose down
```

## Commands

**Strict rule:** every `npm`, `npx`, `node`, `tsc`, and test command runs **inside the container**, never on the host. Running on the host causes env-var divergence (`DB_HOST` resolves to `localhost` instead of the Compose service), uses a different Node version, and produces results that do not reflect what runs in CI/prod.

### Container-only commands (always prefix with `docker compose exec nestjs-api`)

```bash
npm run start:dev                        # Dev server with hot-reload
npm run build                            # Compile to dist/
npm run start:prod                       # Run compiled build
npm run start:worker:dev                 # Video worker with watch (what the video-worker service runs)
npm run start:worker                     # Video worker from the compiled build (node dist/worker)
npm run openapi:export                   # Regenerate openapi.json (re-run after changing any controller/DTO)

npm test                                 # Unit tests
npm run test:watch                       # Unit tests in watch mode
npm run test:cov                         # Coverage report
npm run test:e2e                         # End-to-end tests (always with --runInBand)

npx tsc --noEmit                         # Type-check (required before declaring a task done)
npm run lint                             # ESLint with auto-fix
npm run format                           # Prettier formatting
```

### Host-only commands (Docker / connectivity probes)

```bash
docker compose ps
docker compose logs nestjs-api
docker compose exec db pg_isready -U streamtube
curl http://localhost:3000
```

### Test execution

Integration and e2e suites share a single test database. They **must** be run with `--runInBand`:

```bash
docker compose exec nestjs-api npm test -- --runInBand
docker compose exec nestjs-api npm run test:e2e   # already configured
```

Parallel execution causes FK violations, deadlocks, and cross-suite contamination because suites truncate or seed shared tables concurrently.

During active development, run only the tests related to the file being changed (`npm test -- path/to/file.spec.ts`). Before declaring a task done, run the full suite — see the global `CLAUDE.md` → "Definition of Done (Technical)".

## Long-running Processes

Commands that never exit (dev server, watch modes) must be run in background in the Bash tool — otherwise the agent blocks indefinitely waiting for the process to return.

This applies to: `start:dev`, `start:prod`, `test:watch`, and any other persistent process.

## Test Type Selection

Choose the suffix by what the test really does, not by where the code under test lives. The suffix is a contract that drives Jest config (`testRegex`, parallelism), CI steps, and reader expectations.

| Suffix                  | Purpose                                                              | DB / external I/O | Location                     |
|-------------------------|----------------------------------------------------------------------|-------------------|------------------------------|
| `*.spec.ts`             | **Unit** — pure logic, all collaborators mocked                      | Forbidden         | Next to the source file      |
| `*.integration-spec.ts` | **Integration** — exercises real DB, real repositories, real modules | Required          | Next to the source file      |
| `*.e2e-spec.ts`         | **End-to-end** — full HTTP cycle via `supertest`                     | Required          | `nestjs-project/test/`       |

A test that constructs a `TypeOrmModule.forRoot`, opens a connection, or hits the `db` service **must** be `*.integration-spec.ts`, never `*.spec.ts`. A test that boots the full Nest application and makes HTTP calls **must** be `*.e2e-spec.ts`.

Conventions for **how to write** each kind of test (mocking patterns, AAA structure, override strategies for global guards, etc.) live in `.claude/rules/nestjs-testing.md` and load when you edit a test file.

## Jest Configuration

These settings are required in `package.json` (jest config) and `test/jest-e2e.json` for the project's tests to work correctly:

- `setupFiles: ["dotenv/config"]` — without this, `.env` is not loaded inside the Jest process. `DB_HOST`, `JWT_SECRET`, etc. fall back to undefined or to the host's `localhost`, breaking container-to-container DNS.
- `testRegex: '.*\\.(spec|integration-spec)\\.ts$'` — covers both unit (`*.spec.ts`) and integration (`*.integration-spec.ts`) suffixes.

Do not add new test-file suffixes; if a new test type is needed, update the regex deliberately.

## Videos: storage, queue and worker

Flow, module and file map are in the root `CLAUDE.md` ("Video upload and processing"). Operational notes for this subproject:

- **Variables** (all in `.env.example`, validated at boot by `src/config/env.validation.ts`): `MINIO_ROOT_USER`/`MINIO_ROOT_PASSWORD` (MinIO root account, also used by the app as `S3_ACCESS_KEY`/`S3_SECRET_KEY`), `S3_ENDPOINT`, `S3_PUBLIC_ENDPOINT`, `S3_REGION`, `S3_BUCKET`, `S3_FORCE_PATH_STYLE`, `REDIS_HOST`, `REDIS_PORT`, `QUEUE_PREFIX`, `VIDEO_MAX_SIZE_BYTES`, `VIDEO_UPLOAD_PART_SIZE_BYTES`, `VIDEO_UPLOAD_URL_TTL_SECONDS`, `VIDEO_PLAYBACK_URL_TTL_SECONDS`, `VIDEO_SOURCE_URL_TTL_SECONDS`, `VIDEO_PROCESSING_ATTEMPTS`, `VIDEO_PROCESSING_BACKOFF_MS`.
- **Hosts are service names**, including `S3_PUBLIC_ENDPOINT=http://minio:9000` (the host baked into presigned URLs). To open a presigned URL from the host browser in dev, map the service name in the hosts file: `127.0.0.1 minio` (`/etc/hosts`, or `C:\Windows\System32\drivers\etc\hosts` on Windows). Tests do not need it: they run inside the Compose network.
- **Queue isolation in tests:** `QUEUE_PREFIX` is forced to `bull-test` and `S3_BUCKET` to `streamtube-videos-test` for every Jest run, so the suites never touch the dev worker's queue or the app bucket. A suite that enqueues must clean it (`queue.obliterate({ force: true })`) and close the module in `afterAll` so Redis handles do not keep Jest alive.
- **`bitnamilegacy/minio` is frozen — dev/test only.** Official MinIO images refuse anonymous pulls, so the compose file pins `bitnamilegacy/minio:2025.7.23-debian-12-r5` by tag and digest. It receives no security fixes: CVE-2025-62506 is unpatched, and the code path it affects (STS) is not used here. Never reuse this image outside local development and CI; production uses AWS S3 or a maintained MinIO build.
- **MinIO × production S3:**
  - *CORS:* MinIO answers CORS for every bucket by default and has no `PutBucketCors`. On S3 the bucket needs a CORS rule that allows `PUT`/`GET`/`HEAD` from the frontend origin and **exposes the `ETag` header** — the browser reads each part's `ETag` to send it back in `complete`.
  - *Incomplete multipart uploads:* MinIO has no `AbortIncompleteMultipartUpload` lifecycle action (it reclaims stale uploads on its own schedule; `mc rm --incomplete --recursive --force ALIAS/PATH` removes them by hand). On S3 add a lifecycle rule for it. The API detects an expired upload lazily (`NoSuchUpload` → `UPLOAD_EXPIRED`) and does not clean multipart itself.
- **Worker and FFmpeg:** the worker reads the original through a presigned URL on the *internal* endpoint (ranged reads, no copy to disk) and never exposes that URL. `start:worker:dev` and a `nest start --watch` of the API share `dist/`; do not run both watchers at once on the same bind mount.
- **Manual smoke without HTTP:** the compiled app can be driven from a script (`NestFactory.createApplicationContext(AppModule)` over `dist/`), which exercises the real queue and the dev worker without starting the API server.

## Environment File Conventions

`.env` is parsed by both Docker Compose and `dotenv` — values containing shell-special characters (`<`, `>`, `|`, `&`, spaces) **must be quoted** or rewritten:

```dotenv
# Wrong — the unquoted angle brackets are shell redirection syntax and break parsing
MAIL_FROM=StreamTube <noreply@streamtube.local>

# Right — quote the value
MAIL_FROM="StreamTube <noreply@streamtube.local>"
```

Whenever possible, prefer storing only the bare address in `.env` and composing display names in code (e.g., in `mail.config.ts`) so the file stays shell-safe.

## Build Assets

`tsc` (and therefore `nest build`) only emits compiled `.ts` files to `dist/`. Any non-TypeScript runtime asset — Handlebars templates (`.hbs`), JSON fixtures, static config files, etc. — must be declared in `nest-cli.json` under `compilerOptions.assets` (with `watchAssets: true` for dev). Without that, the file exists in `src/` but is missing in `dist/` and runtime fails only after build.

## Architecture

NestJS with standard module structure. Source lives in `src/`, compiled output in `dist/`.

- Each domain feature gets its own module (e.g., `UsersModule`, `VideosModule`) registered in `AppModule`
- Controllers handle HTTP routing; Services hold business logic; both are scoped to their module

## Code Conventions

- **TypeScript:** `nodenext` module resolution, `ES2023` target, `strictNullChecks` on, `noImplicitAny` off
- **Decorators:** `emitDecoratorMetadata` + `experimentalDecorators` enabled — required for NestJS DI
- **Prettier:** single quotes, trailing commas everywhere
- **ESLint:** `no-explicit-any` allowed; `no-floating-promises` and `no-unsafe-argument` are warnings

## REST Conventions

This is a RESTful API. All endpoints must follow standard REST conventions — correct HTTP methods, proper status codes, plural resource nouns, and consistent URL structure. Details are enforced via rules on controller files.
