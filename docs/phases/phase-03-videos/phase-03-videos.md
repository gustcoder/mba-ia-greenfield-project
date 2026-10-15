---
kind: phase
name: phase-03-videos
test_specs_aware: true
sources_mtime:
  docs/phases/phase-03-videos/context.md: "2026-10-14T19:05:27-03:00"
  docs/phases/phase-03-videos/library-refs.md: "2026-10-14T19:05:06-03:00"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-10-14T19:04:00-03:00"
  docs/decisions/technical-decisions-openapi-docs-nestjs.md: "2026-10-14T12:31:15-03:00"
---

# Phase 03 — Upload e Processamento de Vídeos

## Objective

Entregar upload de vídeos de até 10GB sem impacto na performance da API (upload direto ao object storage, com pré-cadastro automático do vídeo como rascunho ao iniciar o upload), processamento automático em segundo plano via fila e worker (extração de duração e metadados e geração automática de thumbnail a partir de um frame do vídeo), URL única por vídeo sem conflito com outros vídeos, reprodução via streaming sem necessidade de download completo e download do vídeo pelo usuário.

---

## Step Implementations

### SI-03.1 — Infra: dependências, imagem com FFmpeg e serviços Redis/MinIO no Compose

**Description:** Prepara a infraestrutura nova da fase (fila, object storage, binário do FFmpeg) e as libs, sem comportamento de domínio ainda.

**Technical actions:**

1. Instalar no `nestjs-project/` as libs fixadas no `library-refs.md`: `@nestjs/bullmq@^12.0.0`, `bullmq@^6.3.15`, `@aws-sdk/client-s3@^3.1152.0`, `@aws-sdk/s3-request-presigner@^3.1152.0` (per `phase-03-videos/TD-01`, `phase-03-videos/TD-05`)
2. Adicionar `ffmpeg` (pacote Debian, traz `ffprobe`) ao `Dockerfile.dev`, imagem compartilhada pela API, pelo worker e pela suíte de testes (per `phase-03-videos/TD-02`, `phase-03-videos/TD-03`)
3. Adicionar o serviço `redis` ao `compose.yaml`: imagem `redis` com tag fixa da linha 8, `--maxmemory-policy noeviction` (requisito do BullMQ, ver `library-refs.md → bullmq`), healthcheck `redis-cli ping`, porta publicada só em `127.0.0.1` (per `phase-03-videos/TD-01`)
4. Adicionar o serviço `minio` ao `compose.yaml`: `bitnamilegacy/minio:2025.7.23-debian-12-r5@sha256:6dabb4a2088c9a79908de3bc05f4586c23ad2182c8908e7e3acbf61c1467fb20` (tag + digest), `MINIO_ROOT_USER` / `MINIO_ROOT_PASSWORD` vindos do `.env`, `MINIO_DEFAULT_BUCKETS=streamtube-videos,streamtube-videos-test` (bucket da app + bucket de testes), volume nomeado em `/bitnami/minio/data`, portas `9000`/`9001` publicadas só em `127.0.0.1`, healthcheck `curl -f http://localhost:9000/minio/health/live` (per `phase-03-videos/TD-10` revision 2026-10-14, `phase-03-videos/TD-15`)
5. Fazer `nestjs-api` depender de `redis` e `minio` com `condition: service_healthy`; adicionar `MINIO_ROOT_USER` / `MINIO_ROOT_PASSWORD` ao `.env.example`

**Tests:** _(empty — Infra)_

**Dependencies:** none

**Acceptance criteria:**

- `docker compose up -d` sobe `db`, `mailpit`, `redis`, `minio` e `nestjs-api`; `docker compose ps` mostra `redis` e `minio` como `healthy`
- `docker compose exec nestjs-api ffprobe -version` e `docker compose exec nestjs-api ffmpeg -version` executam com sucesso
- `docker compose exec redis redis-cli CONFIG GET maxmemory-policy` retorna `noeviction`
- Os buckets `streamtube-videos` e `streamtube-videos-test` existem no MinIO logo após o primeiro boot do container
- `curl http://localhost:9000/minio/health/live` responde `200` a partir do host; a porta não está publicada em outras interfaces

---

### SI-03.2 — Configurar namespaces de storage, fila e vídeos

**Description:** Cria a configuração tipada e validada que storage, fila, API e worker vão consumir, seguindo as convenções herdadas de config (`registerAs` + Joi).

**Technical actions:**

1. Criar `src/config/storage.config.ts` (`registerAs('storage')`): `endpoint` (`S3_ENDPOINT`, interno, ex. `http://minio:9000`), `publicEndpoint` (`S3_PUBLIC_ENDPOINT`, ex. `http://localhost:9000`), `region` (`S3_REGION`), `accessKeyId` (`S3_ACCESS_KEY`), `secretAccessKey` (`S3_SECRET_KEY`), `bucket` (`S3_BUCKET`), `forcePathStyle` (`S3_FORCE_PATH_STYLE`) (per `phase-03-videos/TD-09`, `phase-01-configuracao-base/TD-03`)
2. Criar `src/config/queue.config.ts` (`registerAs('queue')`): `host` (`REDIS_HOST=redis`), `port` (`REDIS_PORT`), `prefix` (`QUEUE_PREFIX`, default `bull`) (per `phase-03-videos/TD-01`)
3. Criar `src/config/videos.config.ts` (`registerAs('videos')`): `maxSizeBytes` (`VIDEO_MAX_SIZE_BYTES`, default `10737418240`), `uploadPartSizeBytes` (`VIDEO_UPLOAD_PART_SIZE_BYTES`, default `104857600`), `uploadUrlTtlSeconds` (`VIDEO_UPLOAD_URL_TTL_SECONDS`), `playbackUrlTtlSeconds` (`VIDEO_PLAYBACK_URL_TTL_SECONDS`), `sourceUrlTtlSeconds` (`VIDEO_SOURCE_URL_TTL_SECONDS`, URL interna do worker), `processingAttempts` (`VIDEO_PROCESSING_ATTEMPTS`, default `3`), `processingBackoffMs` (`VIDEO_PROCESSING_BACKOFF_MS`, default `10000`) (per `phase-03-videos/TD-06`, `phase-03-videos/TD-11`, `phase-03-videos/TD-14`)
4. Adicionar todas as chaves ao schema Joi de `src/config/env.validation.ts` (part size ≥ 5MiB, TTLs ≤ 604800 s, limite de tamanho ≥ part size) e ao `.env.example` com hosts = nomes de serviço do Compose (per `phase-01-configuracao-base/TD-02`)
5. Criar `src/test/setup-test-env.ts`, registrado em `setupFiles` do Jest unit/integração e do `test/jest-e2e.json` depois de `dotenv/config`, que força `S3_BUCKET=streamtube-videos-test` e `QUEUE_PREFIX=bull-test` nas suítes (per `phase-03-videos/TD-15`)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `env.validation` (chaves novas) | Integration: aceita config válida, rejeita part size < 5MiB e chave obrigatória ausente | `src/config/env.validation.integration-spec.ts` |

**Dependencies:** SI-03.1 — os valores default apontam para os serviços `redis` e `minio` criados lá

**Acceptance criteria:**

- A aplicação sobe com o `.env.example` copiado para `.env` sem erro de validação de configuração
- Remover `S3_ENDPOINT` (ou `REDIS_HOST`) do ambiente faz o bootstrap falhar com mensagem de validação citando a chave
- `VIDEO_UPLOAD_PART_SIZE_BYTES` menor que 5242880 faz o bootstrap falhar na validação
- Durante a execução das suítes Jest, o bucket efetivo é `streamtube-videos-test` e o prefixo de fila é `bull-test`

---

### SI-03.3 — Implementar StorageModule (S3 multipart, presign e objetos)

**Description:** Encapsula todo acesso ao object storage num módulo próprio, para que vídeos e worker nunca falem com o SDK diretamente.

**Technical actions:**

1. Criar `src/storage/storage.module.ts` exportando `StorageService`; construir dois `S3Client` (um no `endpoint` interno, outro no `publicEndpoint`), ambos com `forcePathStyle` e credenciais do namespace `storage` (per `phase-03-videos/TD-09`, `library-refs.md → @aws-sdk/client-s3`)
2. Em `src/storage/storage.service.ts`, operações de multipart: `createMultipartUpload(key, contentType)`, `listParts(key, uploadId)`, `completeMultipartUpload(key, uploadId, parts)`, `abortMultipartUpload(key, uploadId)` (per `phase-03-videos/TD-05`, `phase-03-videos/TD-06`)
3. Operações de presign: `presignUploadPart(key, uploadId, partNumber, ttl)` e `presignGet(key, ttl, { attachmentFilename? })` no cliente público; `presignInternalGet(key, ttl)` no cliente interno, usado pelo worker (per `phase-03-videos/TD-04`, `phase-03-videos/TD-11`, `library-refs.md → @aws-sdk/s3-request-presigner`)
4. Operações de objeto: `headObject(key)` (→ `contentLength`), `putObject(key, body, contentType)`, `deletePrefix(prefix)` (list + delete em lote) (per `phase-03-videos/TD-07`, `phase-03-videos/TD-09`)
5. Traduzir erros do SDK por `error.name` para erros tipados do módulo, sem conhecer o domínio de vídeos: `NoSuchUpload` → `StorageUploadNotFoundError`; `InvalidPart` / `InvalidPartOrder` / `EntityTooSmall` → `StorageInvalidPartsError`; `NotFound` / `NoSuchKey` → `StorageObjectNotFoundError`

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `StorageService` | Integration (MinIO real, bucket de teste): multipart completo via `PUT` nas URLs pré-assinadas com `fetch`, `listParts` após envio parcial, `NoSuchUpload` → `StorageUploadNotFoundError`, `InvalidPart` → `StorageInvalidPartsError`, `deletePrefix` | `src/storage/storage.service.integration-spec.ts` |
| `StorageService` (presign GET) | Integration: URL pública responde `206` a `Range: bytes=0-99`; com `attachmentFilename` responde `Content-Disposition: attachment` | `src/storage/storage.service.integration-spec.ts` |
| `StorageModule` | Unit: compilation test com config de teste | `src/storage/storage.module.spec.ts` |

**Dependencies:** SI-03.2 — consome o namespace `storage`

**Acceptance criteria:**

- Um arquivo enviado em 2 partes via as URLs `PUT` pré-assinadas e finalizado com `completeMultipartUpload` aparece no bucket com o tamanho somado das partes
- `GET` na URL pré-assinada pública com `Range: bytes=0-99` retorna `206` e exatamente 100 bytes
- A URL de download pré-assinada devolve `Content-Disposition: attachment; filename="<nome>"`
- Operar sobre um `uploadId` abortado produz `StorageUploadNotFoundError`, não um erro genérico do SDK
- `deletePrefix('videos/{id}/')` remove todos os objetos daquele prefixo e nenhum outro
- As URLs devolvidas por `presignUploadPart` / `presignGet` usam o host de `S3_PUBLIC_ENDPOINT`; as de `presignInternalGet` usam o de `S3_ENDPOINT`

---

### SI-03.4 — Criar entidade Video, migration CreateVideos e gerador de ID público

**Description:** Materializa a tabela `videos` ligada ao canal e a geração do identificador curto e único da URL.

**Technical actions:**

1. Criar `src/videos/entities/video.entity.ts` com todas as colunas, o enum `videos_status_enum` e a relação many-to-one com `Channel` exatamente como em `### Data Model → Video`; adicionar o lado inverso `@OneToMany(() => Video, (video) => video.channel)` em `Channel` (per `phase-03-videos/TD-13`, `phase-03-videos/TD-03` revision)
2. Gerar `src/database/migrations/<timestamp>-CreateVideos.ts` via `npm run migration:generate`: enum, tabela, FK `channel_id → channels.id ON DELETE CASCADE`, unique em `public_id`, índice em `channel_id`; `down` remove tabela e enum
3. Criar `src/videos/public-id.util.ts` — `generatePublicId()`: 8 bytes de `crypto.randomBytes` codificados em base64url (11 chars, alfabeto `[A-Za-z0-9_-]`) e `isPublicIdFormat(value)` para validar o parâmetro `:videoId` (per `phase-03-videos/TD-08`)
4. Incluir `DELETE FROM "videos"` como primeiro passo de `cleanAllTables` em `src/test/create-test-data-source.ts` (antes de `channels`, por causa da FK)
5. Estender `src/database/migrations.integration-spec.ts` para cobrir a tabela `videos` no `up` e o `down` da `CreateVideos`, sem alterar o setup existente do arquivo (a falha herdada do enum `verification_tokens_type_enum` é tratada fora desta fase)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `Video` | Integration: `public_id` único, FK para canal, default `status = 'draft'`, enum rejeita valor fora da lista, `metadata` jsonb, cascade ao apagar o canal | `src/videos/entities/video.entity.integration-spec.ts` |
| `public-id.util` | Unit: 11 chars, alfabeto base64url, IDs distintos em lote, `isPublicIdFormat` aceita/rejeita | `src/videos/public-id.util.spec.ts` |
| `CreateVideos` migration | Integration: `up` cria `videos` + enum; `down` remove | `src/database/migrations.integration-spec.ts` |

**Dependencies:** none — depende só do banco e da entidade `Channel` da Fase 02

**Acceptance criteria:**

- `npm run migration:run` cria a tabela `videos` com as colunas e o enum `videos_status_enum` (`draft`, `processing`, `ready`, `failed`) definidos no Data Model
- Inserir dois vídeos com o mesmo `public_id` viola a constraint unique
- Inserir um vídeo com `channel_id` inexistente viola a FK; apagar o canal apaga os vídeos dele
- Um vídeo inserido sem `status` explícito é persistido com `status = 'draft'`
- `npm run migration:revert` remove a tabela `videos` e o tipo `videos_status_enum`
- `generatePublicId()` retorna sempre strings de 11 caracteres que casam com `^[A-Za-z0-9_-]{11}$`

---

### SI-03.5 — Configurar a fila BullMQ e o producer `video-processing`

**Description:** Liga a aplicação ao Redis via `@nestjs/bullmq` e expõe um producer único para o job `process-video`, reutilizável pela API e pelo worker.

**Technical actions:**

1. Criar `src/queue/queue.module.ts` com `BullModule.forRootAsync` lendo o namespace `queue` (`connection: { host, port }`, `prefix`) via `@Inject(queueConfig.KEY)` (per `phase-03-videos/TD-01`, `library-refs.md → @nestjs/bullmq`)
2. Criar `src/videos/processing/video-processing.constants.ts` com `VIDEO_PROCESSING_QUEUE = 'video-processing'` e `PROCESS_VIDEO_JOB = 'process-video'` e o tipo do payload `ProcessVideoJobData = { videoId: string }` (per `### Events/Messages`)
3. Registrar a fila em `src/videos/processing/video-processing-queue.module.ts` (`BullModule.registerQueue`) com `defaultJobOptions`: `attempts = processingAttempts`, `backoff: { type: 'exponential', delay: processingBackoffMs }`, `removeOnComplete` / `removeOnFail` por contagem (per `phase-03-videos/TD-14`, `library-refs.md → bullmq`)
4. Criar `src/videos/processing/video-processing.queue.ts` — `VideoProcessingQueue.enqueue(videoId)` faz `queue.add(PROCESS_VIDEO_JOB, { videoId }, { jobId: videoId })`, deduplicando por vídeo (per `phase-03-videos/TD-07`)
5. Importar `QueueModule` no `AppModule`

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideoProcessingQueue` | Integration (Redis real, prefixo `bull-test`): `enqueue` cria o job com `jobId = videoId` e payload `{ videoId }`; segundo `enqueue` do mesmo id não cria job novo; opções `attempts`/`backoff` aplicadas | `src/videos/processing/video-processing.queue.integration-spec.ts` |
| `VideoProcessingQueueModule` | Unit: compilation test (`BullModule.registerQueue` resolve com config de teste) | `src/videos/processing/video-processing-queue.module.spec.ts` |

**Dependencies:** SI-03.2 — consome os namespaces `queue` e `videos`; SI-03.1 — serviço `redis`

**Acceptance criteria:**

- `enqueue(videoId)` deixa na fila `video-processing` um job `process-video` com id igual a `videoId` e payload `{ "videoId": "<uuid>" }`
- Chamar `enqueue` duas vezes para o mesmo vídeo resulta em um único job na fila
- O job criado carrega `attempts` e `backoff` exponencial com os valores do namespace `videos`
- A aplicação e as suítes encerram sem conexões Redis abertas (o Jest termina sozinho após os testes desta SI)

---

### SI-03.6 — Endpoint POST /videos (pré-cadastro do rascunho e abertura do upload)

**Route:** POST /videos
**Test Specs:** see `nestjs-project/specs/videos-create.plan.md`
**Authorization:** Authenticated (o vídeo é criado no canal do próprio usuário)

**Description:** Inicia o upload direto ao storage: cria o vídeo como rascunho e o multipart upload na mesma operação, devolvendo o que o cliente precisa para enviar as partes.

**Technical actions:**

1. Criar `src/videos/videos.module.ts` (importa `TypeOrmModule.forFeature([Video])`, `StorageModule`, `ChannelsModule`) e registrá-lo no `AppModule`; expor em `ChannelsService` a busca do canal pelo `user_id` do token, se ainda não existir
2. Criar as exceções de domínio `UnsupportedMediaTypeException` (`UNSUPPORTED_MEDIA_TYPE`, 400) e `VideoTooLargeException` (`VIDEO_TOO_LARGE`, 400) em `src/videos/exceptions/`, estendendo `DomainException` (per `### Error Catalog`)
3. Criar `src/videos/video-uploads.service.ts` — `initiate(userId, dto)`: valida allowlist e limite, deriva `title` (default = `filename` sem extensão, truncado em 100), gera `id` (uuid) e `public_id`, calcula `storage_key = videos/{id}/original`, `part_size_bytes` (config) e `part_count`, chama `createMultipartUpload` e só então persiste o vídeo `draft` com `upload_id`; em violação de unique de `public_id`, gera outro e repete fora da transação abortada (per `phase-03-videos/TD-07` revision, `phase-03-videos/TD-08`, `phase-03-videos/TD-06`, `.claude/rules/typeorm-queries.md`)
4. Criar os DTOs `InitiateVideoUploadDto` (`filename`, `mime_type`, `size_bytes`, `title?`), `VideoResponseDto`, `UploadSessionDto` e o mapper `toVideoResponse(video)` que assina `thumbnail_url` via `presignGet` quando `thumbnail_key` não é `null` e converte `size_bytes` para `number` (per `### API Contracts`)
5. Criar `src/videos/videos.controller.ts` (`@Controller('videos')`, `@ApiTags('videos')`, `@ApiBearerAuth('access-token')`) com `POST /videos` → `201 { video, upload }` e decorators OpenAPI para `201`/`400`/`401` referenciando `ApiErrorEnvelope` (per `openapi-docs-nestjs/TD-01` revision, `.claude/rules/nestjs-controllers.md`)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideoUploadsService.initiate` | Unit (mocks de repo/storage): title default e truncamento, `part_count` arredondado para cima, MIME fora da allowlist → `UNSUPPORTED_MEDIA_TYPE`, tamanho acima do limite → `VIDEO_TOO_LARGE`, retry quando `public_id` colide | `src/videos/video-uploads.service.spec.ts` |
| `VideoUploadsService.initiate` | Integration (Postgres + MinIO reais): linha `draft` persistida com `upload_id`, `storage_key`, `part_size_bytes`, `part_count`; multipart existe no storage (`listParts` vazio) | `src/videos/video-uploads.service.integration-spec.ts` |
| `VideosModule` | Unit: compilation test | `src/videos/videos.module.spec.ts` |

**Dependencies:** SI-03.3 — `createMultipartUpload` e `presignGet`; SI-03.4 — entidade `Video` e `generatePublicId`

**Acceptance criteria:**

- `POST /videos` autenticado com `{ filename: "aula.mp4", mime_type: "video/mp4", size_bytes: 314572800 }` retorna `201` com `video.status = "draft"`, `video.title = "aula"`, `video.id` de 11 chars e `upload = { part_size_bytes: 104857600, part_count: 3 }`
- Após o `201`, a tabela `videos` tem a linha `draft` no canal do usuário e existe um multipart upload aberto em `videos/{id}/original`
- `POST /videos` com `mime_type: "image/png"` retorna `400` com `error: "UNSUPPORTED_MEDIA_TYPE"` e nenhuma linha é criada
- `POST /videos` com `size_bytes: 10737418241` retorna `400` com `error: "VIDEO_TOO_LARGE"`
- `POST /videos` sem `filename` retorna `400` com `error: "VALIDATION_ERROR"`
- `POST /videos` sem token retorna `401`
- A resposta não expõe `upload_id`, `storage_key` nem o `id` interno (uuid)

---

### SI-03.7 — Endpoints de assinatura de partes e retomada do upload

**Route:** POST /videos/:videoId/upload/part-urls, GET /videos/:videoId/upload/parts
**Test Specs:** see `nestjs-project/specs/videos-upload-parts.plan.md`
**Authorization:** Owner

**Description:** Entrega o envio das partes direto ao storage com URLs assinadas sob demanda e a retomada após queda de conexão, incluindo a detecção preguiçosa de upload expirado.

**Technical actions:**

1. Criar as exceções `VideoNotFoundException` (`VIDEO_NOT_FOUND`, 404), `InvalidUploadStateException` (`INVALID_UPLOAD_STATE`, 409), `InvalidPartNumberException` (`INVALID_PART_NUMBER`, 400) e `UploadExpiredException` (`UPLOAD_EXPIRED`, 410) (per `### Error Catalog`)
2. Criar em `src/videos/videos.service.ts` o `findOwnedByPublicId(userId, publicId)`: formato inválido, inexistente ou de outro canal → `VideoNotFoundException` (mesma resposta nos três casos) (per `phase-03-videos/TD-12`, `### Authorization Matrix`)
3. Em `VideoUploadsService`: `signParts(userId, publicId, partNumbers)` (exige `draft`, valida `1..part_count`, assina com `uploadUrlTtlSeconds`, devolve `expires_at`) e `listUploadedParts(userId, publicId)` (exige `draft`, mapeia `listParts`) (per `phase-03-videos/TD-06`)
4. Tratar `StorageUploadNotFoundError` nessas operações: grava `status = 'failed'`, `failure_reason = 'UPLOAD_EXPIRED'`, `upload_id = null` e lança `UploadExpiredException` (per `phase-03-videos/TD-13` revision 2026-10-14)
5. Adicionar ao `VideosController` `POST /videos/:videoId/upload/part-urls` (`@HttpCode(200)`, DTO `SignUploadPartsDto` com `part_numbers` 1..100 únicos) e `GET /videos/:videoId/upload/parts`, com decorators OpenAPI para `200`/`400`/`401`/`404`/`409`/`410`

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideosService.findOwnedByPublicId` | Integration (Postgres real): dono encontra; outro usuário, id inexistente e id mal formado → `VIDEO_NOT_FOUND` | `src/videos/videos.service.integration-spec.ts` |
| `VideoUploadsService.signParts` / `listUploadedParts` | Unit: estado ≠ `draft` → `INVALID_UPLOAD_STATE`; parte fora do intervalo → `INVALID_PART_NUMBER`; `StorageUploadNotFoundError` → vídeo `failed`/`UPLOAD_EXPIRED` + `UploadExpiredException` | `src/videos/video-uploads.service.spec.ts` |
| `VideoUploadsService.signParts` / `listUploadedParts` | Integration (Postgres + MinIO reais): `PUT` numa URL assinada é aceito pelo storage e a parte aparece em `listUploadedParts`; multipart abortado por fora → vídeo vira `failed` | `src/videos/video-uploads.service.integration-spec.ts` |

**Dependencies:** SI-03.6 — vídeo `draft` com multipart aberto e `VideosController`

**Acceptance criteria:**

- `POST /videos/:videoId/upload/part-urls` do dono com `{ part_numbers: [1, 2] }` retorna `200` com duas URLs `PUT` e `expires_at`; um `PUT` de bytes numa dessas URLs é aceito pelo storage e devolve `ETag`
- `GET /videos/:videoId/upload/parts` após enviar a parte 1 retorna `200` com `uploaded_parts` contendo `part_number: 1` e o `etag` correspondente
- `POST .../part-urls` com `part_numbers: [0]` ou acima de `part_count` retorna `400` com `error: "INVALID_PART_NUMBER"`
- `POST .../part-urls` para um vídeo que não está em `draft` retorna `409` com `error: "INVALID_UPLOAD_STATE"`
- Com o multipart expirado/abortado no storage, `GET .../parts` retorna `410` com `error: "UPLOAD_EXPIRED"` e o vídeo passa a `status = 'failed'`, `failure_reason = 'UPLOAD_EXPIRED'`
- `GET .../parts` de um vídeo de outro usuário, de um id inexistente ou de um id mal formado retorna `404` com `error: "VIDEO_NOT_FOUND"` em todos os casos

---

### SI-03.8 — Endpoint de conclusão do upload com enfileiramento do processamento

**Route:** POST /videos/:videoId/upload/complete
**Test Specs:** see `nestjs-project/specs/videos-upload-complete.plan.md`
**Authorization:** Owner

**Description:** Fecha o multipart, garante o limite de 10GB sobre o objeto realmente montado e dispara o processamento automático, de forma idempotente.

**Technical actions:**

1. Criar a exceção `InvalidUploadPartsException` (`INVALID_UPLOAD_PARTS`, 400) (per `### Error Catalog`)
2. Em `VideoUploadsService.complete(userId, publicId, parts)` para vídeo `draft`: `completeMultipartUpload` → `headObject`; se `contentLength > maxSizeBytes`, `deletePrefix`, grava `failed`/`FILE_TOO_LARGE` e lança `VideoTooLargeException`; senão grava `size_bytes` confirmado, `upload_id = null`, `status = 'processing'` e chama `VideoProcessingQueue.enqueue(video.id)` (per `phase-03-videos/TD-07`)
3. Idempotência: vídeo já em `processing` → reenfileira (dedup por `jobId` torna seguro e cobre falha de enqueue numa chamada anterior) e devolve o estado atual; vídeo em `ready` → devolve sem enfileirar; vídeo em `failed` → `InvalidUploadStateException` (per `phase-03-videos/TD-07`, `phase-03-videos/TD-01`)
4. Mapear erros do storage: `StorageInvalidPartsError` → `InvalidUploadPartsException` (vídeo continua `draft`); `StorageUploadNotFoundError` → transição `UPLOAD_EXPIRED` da SI-03.7 (per `phase-03-videos/TD-13` revision)
5. Adicionar ao `VideosController` `POST /videos/:videoId/upload/complete` (`@HttpCode(200)`, DTO `CompleteVideoUploadDto` com `parts: { part_number, etag }[]`), com decorators OpenAPI para `200`/`400`/`401`/`404`/`409`/`410`; importar `VideoProcessingQueueModule` no `VideosModule`

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideoUploadsService.complete` | Unit: ramos `draft` → `processing` + enqueue; `processing` → reenfileira sem regravar; `ready` → sem enqueue; `failed` → `INVALID_UPLOAD_STATE`; objeto acima do limite → `failed`/`FILE_TOO_LARGE`; partes inválidas → `INVALID_UPLOAD_PARTS` | `src/videos/video-uploads.service.spec.ts` |
| `VideoUploadsService.complete` | Integration (Postgres + MinIO + Redis reais): upload real de 2 partes → objeto montado, vídeo `processing`, job `process-video` na fila com `jobId = videos.id`; segunda chamada não duplica o job | `src/videos/video-uploads.service.integration-spec.ts` |

**Dependencies:** SI-03.7 — partes enviadas e `findOwnedByPublicId`; SI-03.5 — `VideoProcessingQueue`

**Acceptance criteria:**

- `POST /videos/:videoId/upload/complete` do dono com as partes e `ETag`s corretos retorna `200` com `status: "processing"`, o objeto `videos/{id}/original` existe no storage e a fila `video-processing` tem um job com id igual ao `id` interno do vídeo
- Repetir a mesma chamada retorna `200` com o vídeo no estado atual e a fila continua com um único job para o vídeo
- `complete` com um `ETag` errado retorna `400` com `error: "INVALID_UPLOAD_PARTS"` e o vídeo continua `draft`, podendo repetir com os dados corretos
- `complete` cujo objeto montado excede `VIDEO_MAX_SIZE_BYTES` retorna `400` com `error: "VIDEO_TOO_LARGE"`, remove o objeto e deixa o vídeo `failed` com `failure_reason = 'FILE_TOO_LARGE'`
- `complete` em vídeo `failed` retorna `409` com `error: "INVALID_UPLOAD_STATE"`
- `complete` com o multipart expirado no storage retorna `410` com `error: "UPLOAD_EXPIRED"` e o vídeo vira `failed`/`UPLOAD_EXPIRED`

---

### SI-03.9 — Endpoints de reinício do upload expirado e exclusão do vídeo não processado

**Route:** POST /videos/:videoId/upload/restart, DELETE /videos/:videoId
**Test Specs:** see `nestjs-project/specs/videos-upload-restart-delete.plan.md`
**Authorization:** Owner

**Description:** Completa o tratamento de uploads interrompidos: o dono pode reabrir um upload expirado no mesmo vídeo (mesma URL) ou excluir um vídeo que não chegou a ser processado.

**Technical actions:**

1. Em `VideoUploadsService.restart(userId, publicId, dto)`: exige `status = 'failed'` com `failure_reason = 'UPLOAD_EXPIRED'`; aplica o `size_bytes` novo (se enviado) com as mesmas regras do initiate, recalcula `part_count`, abre novo `createMultipartUpload` na mesma `storage_key` e grava `status = 'draft'`, `failure_reason = null`, novo `upload_id` (per `phase-03-videos/TD-13` revision 2026-10-14)
2. Em `VideosService.deleteOwned(userId, publicId)`: exige `status` em `draft` ou `failed`; se houver `upload_id`, `abortMultipartUpload` (ignorando `StorageUploadNotFoundError`); `deletePrefix('videos/{id}/')`; apaga a linha (per `phase-03-videos/TD-13` revision, `phase-03-videos/TD-09`)
3. Criar o DTO `RestartVideoUploadDto` (`size_bytes?`)
4. Adicionar ao `VideosController` `POST /videos/:videoId/upload/restart` (`@HttpCode(200)`, `{ video, upload }`) e `DELETE /videos/:videoId` (`@HttpCode(204)`), com decorators OpenAPI para `200`/`204`/`400`/`401`/`404`/`409`

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideoUploadsService.restart` | Unit: só aceita `failed` + `UPLOAD_EXPIRED` (`failed` por outro motivo, `draft`, `processing`, `ready` → `INVALID_UPLOAD_STATE`); `size_bytes` acima do limite → `VIDEO_TOO_LARGE`; recálculo de `part_count` | `src/videos/video-uploads.service.spec.ts` |
| `VideosService.deleteOwned` | Unit: `processing`/`ready` → `INVALID_UPLOAD_STATE`; abort só quando há `upload_id`; `NoSuchUpload` no abort não impede a exclusão | `src/videos/videos.service.spec.ts` |
| `restart` + `deleteOwned` | Integration (Postgres + MinIO reais): restart abre multipart novo que aceita partes; delete remove objetos do prefixo e a linha | `src/videos/videos.service.integration-spec.ts` |

**Dependencies:** SI-03.7 — `findOwnedByPublicId` e a transição para `failed`/`UPLOAD_EXPIRED`

**Acceptance criteria:**

- `POST /videos/:videoId/upload/restart` de um vídeo `failed`/`UPLOAD_EXPIRED` retorna `200` com `video.status = "draft"`, o mesmo `video.id` de antes e um `upload` novo; as URLs assinadas em seguida aceitam partes
- `POST .../upload/restart` de um vídeo `failed` com `failure_reason = 'INVALID_MEDIA'` (ou em `draft`/`processing`/`ready`) retorna `409` com `error: "INVALID_UPLOAD_STATE"`
- `DELETE /videos/:videoId` de um vídeo `draft` retorna `204`; o multipart é abortado, nenhum objeto resta em `videos/{id}/` e a linha não existe mais na tabela `videos`
- `DELETE /videos/:videoId` de um vídeo `ready` ou `processing` retorna `409` com `error: "INVALID_UPLOAD_STATE"` e nada é removido
- `DELETE` ou `restart` sobre vídeo de outro usuário retorna `404` com `error: "VIDEO_NOT_FOUND"`

---

### SI-03.10 — Implementar o serviço de mídia (ffprobe e thumbnail via FFmpeg)

**Description:** Encapsula a extração de metadados e a geração do thumbnail sobre o binário do sistema, independente de fila e de banco, para o worker apenas orquestrar.

**Technical actions:**

1. Criar `src/media/media.module.ts` e `src/media/ffmpeg-runner.ts` — wrapper de `child_process.spawn` com timeout, captura de `stdout` (buffer) e `stderr` (para a mensagem de erro) e rejeição tipada em exit code ≠ 0 (per `phase-03-videos/TD-03`)
2. Em `src/media/media.service.ts`, `probe(input)`: roda `ffprobe -v error -print_format json -show_format -show_streams <input>`; sem stream `codec_type = 'video'` → `InvalidMediaError`; mapeia para `{ durationSeconds, width, height, videoCodec, sizeBytes, metadata }`, onde `metadata` é o resumo de `format` + `streams` (per `phase-03-videos/TD-03` revision 2026-10-14)
3. Em `MediaService`, `extractThumbnail(input, durationSeconds)`: `ffmpeg -ss <10% da duração> -i <input> -frames:v 1 -vf "scale='min(1280,iw)':-2" -f image2 -c:v mjpeg pipe:1` → `Buffer` JPEG; se falhar ou vier vazio, repete com `-ss 0` (per `phase-03-videos/TD-03` revision 2026-10-14)
4. Aceitar como `input` tanto caminho local quanto URL `http(s)` (a URL interna pré-assinada do storage) sem baixar o arquivo, deixando o FFmpeg ler por range (per `phase-03-videos/TD-04`)
5. Criar o helper de teste `src/test/video-fixtures.ts` que gera, com o próprio ffmpeg, um vídeo curto (`-f lavfi -i testsrc=duration=3:size=640x360`) e um arquivo não-vídeo, em diretório temporário

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `MediaService` (mapeamento) | Unit: JSON de ffprobe → duração/dimensões/codec/metadata; JSON sem stream de vídeo → `InvalidMediaError`; cálculo do instante de 10% | `src/media/media.service.spec.ts` |
| `MediaService` (binário real) | Integration (ffmpeg do container + MinIO): `probe` do fixture retorna ~3 s e 640x360; arquivo não-vídeo → `InvalidMediaError`; `extractThumbnail` devolve JPEG válido com largura ≤ 1280; `probe` sobre URL interna pré-assinada funciona sem cópia local | `src/media/media.service.integration-spec.ts` |
| `MediaModule` | Unit: compilation test | `src/media/media.module.spec.ts` |

**Dependencies:** SI-03.1 — `ffmpeg`/`ffprobe` na imagem; SI-03.3 — `presignInternalGet` para o teste com URL

**Acceptance criteria:**

- `probe` de um vídeo de 3 s em 640x360 retorna `durationSeconds ≈ 3`, `width = 640`, `height = 360` e o `videoCodec` do arquivo
- `probe` de um arquivo sem stream de vídeo falha com `InvalidMediaError`
- `extractThumbnail` devolve bytes JPEG (assinatura `FF D8`) de um frame com largura ≤ 1280 px e proporção preservada
- `probe` e `extractThumbnail` funcionam recebendo a URL interna pré-assinada de um objeto no MinIO, sem gravar o vídeo em disco
- Um processo ffmpeg/ffprobe que excede o timeout é encerrado e a chamada falha com erro, sem deixar o processo pendurado

---

### SI-03.11 — Implementar o worker de vídeo (entrypoint, processor e serviço no Compose)

**Description:** Cria o processo separado que consome `process-video`, aplica o contrato de processamento e fecha o ciclo `processing → ready | failed` no banco.

**Technical actions:**

1. Criar `src/worker/worker.module.ts` (Config + TypeORM + `QueueModule` + `VideoProcessingQueueModule` + `StorageModule` + `MediaModule` + `TypeOrmModule.forFeature([Video])`, sem controllers HTTP) e `src/worker.ts` com `NestFactory.createApplicationContext(WorkerModule)` + `enableShutdownHooks()` (per `phase-03-videos/TD-02`)
2. Criar `src/videos/processing/video-processing.processor.ts` — `@Processor(VIDEO_PROCESSING_QUEUE)` estendendo `WorkerHost`, implementando os passos 1–6 do `### Events/Messages → Processing contract` (carrega vídeo; ignora se não está `processing`; `presignInternalGet` com `sourceUrlTtlSeconds`; `probe`; `extractThumbnail` → `putObject('videos/{id}/thumbnail.jpg')`; atualização única para `ready`) (per `phase-03-videos/TD-04`, `phase-03-videos/TD-03`, `library-refs.md → @nestjs/bullmq`)
3. Tratar falhas no processor: `InvalidMediaError` → grava `failed`/`INVALID_MEDIA` e lança `UnrecoverableError`; outros erros → na última tentativa (`attemptsMade + 1 >= opts.attempts`) grava `failed`/`PROCESSING_FAILED` antes de relançar, nas anteriores só relança para o retry com backoff (per `phase-03-videos/TD-14`, `library-refs.md → bullmq`)
4. Adicionar os scripts `start:worker` (`node dist/worker`) e `start:worker:dev` (watch) ao `package.json`
5. Adicionar o serviço `video-worker` ao `compose.yaml`: mesmo build/volume do `nestjs-api`, comando `npm run start:worker:dev`, `depends_on` `db`/`redis`/`minio` saudáveis, sem portas publicadas (per `phase-03-videos/TD-02`)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideoProcessingProcessor` | Unit (mocks de repo/storage/media): vídeo ausente ou não `processing` → no-op; sucesso grava metadados + `thumbnail_key` + `ready`; `InvalidMediaError` → `failed`/`INVALID_MEDIA` + `UnrecoverableError`; erro transitório na última tentativa → `failed`/`PROCESSING_FAILED`; em tentativa intermediária → só relança | `src/videos/processing/video-processing.processor.spec.ts` |
| `VideoProcessingProcessor` | Integration (Postgres + MinIO + ffmpeg reais): fixture enviado ao storage + vídeo `processing` → `process()` deixa o vídeo `ready` com duração/dimensões/codec/metadata e `videos/{id}/thumbnail.jpg` existe; arquivo não-vídeo → `failed`/`INVALID_MEDIA` | `src/videos/processing/video-processing.processor.integration-spec.ts` |
| `WorkerModule` | Unit: compilation test | `src/worker/worker.module.spec.ts` |

**Dependencies:** SI-03.10 — `MediaService`; SI-03.5 — fila e constantes; SI-03.3 — storage; SI-03.4 — entidade `Video`; SI-03.8 — o `complete` é quem enfileira o job no fluxo real

**Acceptance criteria:**

- `docker compose up -d` sobe o serviço `video-worker`, que conecta ao Redis e fica consumindo a fila `video-processing` sem expor porta HTTP
- Um vídeo cujo upload foi concluído via `POST /videos/:videoId/upload/complete` passa sozinho de `processing` para `ready`, com `duration_seconds`, `width`, `height`, `video_codec` e `metadata` preenchidos e `thumbnail_key = 'videos/{id}/thumbnail.jpg'`
- O objeto `videos/{id}/thumbnail.jpg` existe no storage, é JPEG e tem largura ≤ 1280 px
- Um upload concluído de um arquivo que não é vídeo termina em `status = 'failed'`, `failure_reason = 'INVALID_MEDIA'` após uma única tentativa
- Com o storage indisponível durante o processamento, o job é retentado com backoff e, esgotadas as tentativas, o vídeo fica `failed` com `failure_reason = 'PROCESSING_FAILED'`
- Um job reentregue para um vídeo já `ready` termina sem alterar a linha

---

### SI-03.12 — Endpoints de detalhe, streaming e download do vídeo

**Route:** GET /videos/:videoId, GET /videos/:videoId/stream, GET /videos/:videoId/download
**Test Specs:** see `nestjs-project/specs/videos-detail-stream-download.plan.md`
**Authorization:** Owner

**Description:** Expõe ao dono o estado do vídeo e as URLs pré-assinadas de reprodução (com range/206 servido pelo storage) e de download, sem que bytes passem pela API.

**Technical actions:**

1. Criar a exceção `VideoNotReadyException` (`VIDEO_NOT_READY`, 409) (per `### Error Catalog`)
2. Em `VideosService`: `getOwned(userId, publicId)` → `VideoResponseDto` (via `toVideoResponse`, com `thumbnail_url` assinado quando houver thumbnail) (per `phase-03-videos/TD-12` revision 2026-10-14)
3. Em `VideosService`: `getStreamUrl` e `getDownloadUrl` — exigem `status = 'ready'`, assinam `presignGet(storage_key, playbackUrlTtlSeconds)`; o download passa `attachmentFilename = original_filename`; ambos devolvem `{ url, expires_at }` (per `phase-03-videos/TD-11`)
4. Adicionar ao `VideosController` `GET /videos/:videoId`, `GET /videos/:videoId/stream` e `GET /videos/:videoId/download`, com DTO `PresignedUrlResponseDto` e decorators OpenAPI para `200`/`401`/`404`/`409`

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideosService.getStreamUrl` / `getDownloadUrl` | Unit: `status` ≠ `ready` → `VIDEO_NOT_READY`; download inclui o nome original na disposição; TTL do config aplicado | `src/videos/videos.service.spec.ts` |
| `VideosService` (detalhe + URLs) | Integration (Postgres + MinIO reais): `thumbnail_url` presente só com thumbnail; URL de stream responde `206` a `Range`; URL de download responde `Content-Disposition: attachment` | `src/videos/videos.service.integration-spec.ts` |

**Dependencies:** SI-03.7 — `findOwnedByPublicId`; SI-03.3 — `presignGet`

**Acceptance criteria:**

- `GET /videos/:videoId` do dono retorna `200` com o `VideoResponseDto` refletindo o `status` atual; para vídeo `ready`, inclui `duration_seconds`, `width`, `height`, `video_codec` e `thumbnail_url` não nulo
- `GET /videos/:videoId/stream` de vídeo `ready` retorna `200` com `{ url, expires_at }`, e um `GET` na `url` com `Range: bytes=0-1023` retorna `206` com 1024 bytes
- `GET /videos/:videoId/download` de vídeo `ready` retorna `200` com `{ url, expires_at }`, e a `url` responde com `Content-Disposition: attachment; filename="<original_filename>"`
- `GET /videos/:videoId/stream` ou `/download` de vídeo `draft`, `processing` ou `failed` retorna `409` com `error: "VIDEO_NOT_READY"`
- Qualquer dos três endpoints sobre vídeo de outro usuário retorna `404` com `error: "VIDEO_NOT_FOUND"`; sem token retorna `401`

---

### SI-03.13 — Atualizar o contrato OpenAPI e a documentação de IA (seção de vídeos)

**Description:** Deixa o `openapi.json` exportado e os `CLAUDE.md` coerentes com o código entregue na fase: módulo de vídeos, endpoints, fila/worker e storage.

**Technical actions:**

1. Rodar `npm run openapi:export` e commitar o `nestjs-project/openapi.json` regenerado com os endpoints `/videos` e seus schemas de erro (per `openapi-docs-nestjs/TD-02`)
2. Estender `src/openapi-export.integration-spec.ts` para afirmar que os paths `/videos`, `/videos/{videoId}`, `/videos/{videoId}/upload/part-urls`, `/videos/{videoId}/upload/parts`, `/videos/{videoId}/upload/complete`, `/videos/{videoId}/upload/restart`, `/videos/{videoId}/stream` e `/videos/{videoId}/download` constam do documento com `bearer` e respostas de erro referenciando `ApiErrorEnvelope`
3. Atualizar `nestjs-project/CLAUDE.md`: serviços novos (`redis`, `minio`, `video-worker`) com verificação de prontidão, comando do worker, buckets (app e teste) e variáveis novas; aviso de que a imagem `bitnamilegacy/minio` é congelada e só para dev/testes (CVE-2025-62506 não corrigida; o caminho STS não é usado); diferenças MinIO × S3 de produção (CORS por bucket expondo `ETag` e regra de lifecycle para multipart incompleto) (per `phase-03-videos/TD-10` revision, `library-refs.md → minio`)
4. Atualizar o `CLAUDE.md` da raiz: seção de vídeos descrevendo o fluxo (initiate → part-urls → PUT direto no storage → complete → fila `video-processing` → worker → `ready`), a fila definida (BullMQ + Redis) no lugar do "TBD" e onde ficam módulo, worker e storage

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `openapi.json` (endpoints de vídeos) | Integration: documento exportado contém os paths de `/videos` com segurança bearer e envelope de erro | `src/openapi-export.integration-spec.ts` |

**Dependencies:** SI-03.6, SI-03.7, SI-03.8, SI-03.9, SI-03.11, SI-03.12 — documentação e contrato refletem os endpoints e o worker já implementados

**Acceptance criteria:**

- `nestjs-project/openapi.json` contém os 9 endpoints de `/videos` da fase, todos com `security: bearer` e respostas de erro apontando para `ApiErrorEnvelope`
- Rodar `npm run openapi:export` de novo não altera o `openapi.json` commitado
- Todo arquivo, serviço do Compose, script npm e variável de ambiente citado nas seções novas dos `CLAUDE.md` existe no repositório
- O `CLAUDE.md` da raiz não descreve mais a fila como "TBD"

---

## Technical Specifications

### Data Model

#### Video

Tabela `videos`. Um vídeo pertence a um canal (o canal do usuário autenticado no momento do upload).

| Column | Type | Constraints | Notes |
|--------|------|-------------|-------|
| id | uuid | PK, generated | Identificador interno; usado nas chaves de storage e como `jobId` da fila (per `phase-03-videos/TD-07`, `phase-03-videos/TD-09`) |
| public_id | varchar(11) | unique, not null | ID público da URL: 11 chars base64url gerados de 8 bytes de `node:crypto`; colisão → nova tentativa (per `phase-03-videos/TD-08`) |
| channel_id | uuid | FK → channels.id, not null, `ON DELETE CASCADE` | Dono do vídeo |
| title | varchar(100) | not null | Opcional na iniciação; default = nome do arquivo original sem extensão (per `phase-03-videos/TD-07` revision 2026-10-14) |
| status | enum `videos_status_enum` | not null, default `'draft'`, values: `'draft'`, `'processing'`, `'ready'`, `'failed'` | Ciclo de processamento; publicação/visibilidade fica para a Fase 04 como campo ortogonal (per `phase-03-videos/TD-13`) |
| failure_reason | varchar(50) | nullable | Preenchido só quando `status = 'failed'`: `UPLOAD_EXPIRED`, `FILE_TOO_LARGE`, `INVALID_MEDIA`, `PROCESSING_FAILED` (per `phase-03-videos/TD-13`, `phase-03-videos/TD-14`) |
| original_filename | varchar(255) | not null | Nome do arquivo declarado na iniciação; usado no `Content-Disposition` do download (per `phase-03-videos/TD-11`) |
| mime_type | varchar(50) | not null | Um dos tipos da allowlist (per `phase-03-videos/TD-05` revision 2026-10-14) |
| size_bytes | bigint | not null | Declarado na iniciação; confirmado via `HeadObject` no complete (per `phase-03-videos/TD-03` revision, `phase-03-videos/TD-07`) |
| storage_key | varchar(255) | not null | `videos/{id}/original` (per `phase-03-videos/TD-09`) |
| thumbnail_key | varchar(255) | nullable | `videos/{id}/thumbnail.jpg`; preenchido quando o processamento termina (per `phase-03-videos/TD-09`) |
| upload_id | varchar(255) | nullable | `UploadId` do multipart em andamento; `null` depois do complete (per `phase-03-videos/TD-05`, `phase-03-videos/TD-07`) |
| part_size_bytes | integer | not null | Tamanho fixo da parte, gravado na iniciação para que o resume não dependa de mudança de config (per `phase-03-videos/TD-06`) |
| part_count | integer | not null | `ceil(size_bytes / part_size_bytes)`; teto para os números de parte assináveis (per `phase-03-videos/TD-06`) |
| duration_seconds | double precision | nullable | Preenchido pelo worker (per `phase-03-videos/TD-03` revision 2026-10-14) |
| width | integer | nullable | Idem |
| height | integer | nullable | Idem |
| video_codec | varchar(50) | nullable | Idem |
| metadata | jsonb | nullable | Resumo do ffprobe (`format` + `streams`) (per `phase-03-videos/TD-03` revision 2026-10-14) |
| created_at | timestamp | not null, auto-generated | `@CreateDateColumn` |
| updated_at | timestamp | not null, auto-generated | `@UpdateDateColumn` |

**Relations:** Video → Channel (many-to-one, owning side via `channel_id`); Channel → Video (one-to-many, inverse side)
**Indexes:** `(public_id)` — unique; `(channel_id)` — FK lookups por dono
**Status transitions:** `draft → processing` (complete); `processing → ready` (worker); `processing → failed` (`INVALID_MEDIA` | `PROCESSING_FAILED`); `draft → failed` (`FILE_TOO_LARGE`, no complete, quando o objeto montado excede o limite); `draft → failed` (`UPLOAD_EXPIRED`, detecção preguiçosa via `NoSuchUpload`); `failed (UPLOAD_EXPIRED) → draft` (restart). Nenhuma outra transição é permitida (per `phase-03-videos/TD-13`, `phase-03-videos/TD-14`).
**TypeORM note:** colunas `bigint` são lidas como `string` pelo driver `pg`; converter `size_bytes` para `number` na camada de serviço/DTO (10GB < `Number.MAX_SAFE_INTEGER`).

### API Contracts

Todos os endpoints exigem `Authorization: Bearer <access_token>` (guard JWT global, sem `@Public()`) e só operam sobre vídeos do canal do usuário autenticado (per `phase-03-videos/TD-12`). `:videoId` é sempre o `public_id` de 11 chars (per `phase-03-videos/TD-08`). Vídeo inexistente **ou** de outro canal responde igual (`404 VIDEO_NOT_FOUND`), para não revelar a existência de vídeos alheios. Os bytes do vídeo nunca passam pela API: upload e leitura usam URLs pré-assinadas do storage (per `phase-03-videos/TD-05`, `phase-03-videos/TD-11`), assinadas contra o endpoint público do storage (per `phase-03-videos/TD-09`).

**Video response shape** (`VideoResponseDto`, reutilizado pelos endpoints que devolvem o vídeo):
- id: string — `public_id`
- title: string
- status: `'draft' | 'processing' | 'ready' | 'failed'`
- failure_reason: string | null
- original_filename: string
- mime_type: string
- size_bytes: number
- duration_seconds: number | null
- width: number | null
- height: number | null
- video_codec: string | null
- thumbnail_url: string | null — URL GET pré-assinada do thumbnail; `null` enquanto `thumbnail_key` for `null`
- created_at: string (ISO-8601)
- updated_at: string (ISO-8601)

**Upload session shape** (`UploadSessionDto`):
- part_size_bytes: number
- part_count: number

---

#### POST /videos (SI-03.5)

Pré-cadastra o vídeo como rascunho e abre o multipart upload no storage (per `phase-03-videos/TD-07`, `phase-03-videos/TD-05`, `phase-03-videos/TD-06`).

**Request headers:**
- Content-Type: application/json

**Request body:**
- filename: string, required — 1..255 chars
- mime_type: string, required — um de `video/mp4`, `video/quicktime`, `video/webm`, `video/x-matroska` (per `phase-03-videos/TD-05` revision 2026-10-14)
- size_bytes: integer, required — ≥ 1 e ≤ `VIDEO_MAX_SIZE_BYTES` (10GB = 10737418240)
- title: string, optional — 1..100 chars; quando omitido, `filename` sem extensão (truncado em 100) (per `phase-03-videos/TD-07` revision 2026-10-14)

**Response 201:**
- video: `VideoResponseDto` (status `draft`)
- upload: `UploadSessionDto`

**Error responses:**
- 400 UNSUPPORTED_MEDIA_TYPE: `mime_type` fora da allowlist
- 400 VIDEO_TOO_LARGE: `size_bytes` acima de `VIDEO_MAX_SIZE_BYTES`
- 400 VALIDATION_ERROR: corpo não passa na validação do DTO
- 401: access token ausente/inválido (guard global)

---

#### POST /videos/:videoId/upload/part-urls (SI-03.6)

Assina, sob demanda, as URLs de `UploadPart` para os números de parte pedidos (per `phase-03-videos/TD-06`). Não cria recurso — responde 200.

**Request headers:**
- Content-Type: application/json

**Request body:**
- part_numbers: integer[], required — 1..100 itens, únicos, cada um em `1..part_count`

**Response 200:**
- parts: `{ part_number: number, url: string }[]` — URLs `PUT` pré-assinadas (TTL `VIDEO_UPLOAD_URL_TTL_SECONDS`)
- expires_at: string (ISO-8601)

**Error responses:**
- 404 VIDEO_NOT_FOUND: vídeo inexistente ou de outro canal
- 409 INVALID_UPLOAD_STATE: `status` diferente de `draft`
- 400 INVALID_PART_NUMBER: algum número fora de `1..part_count`
- 410 UPLOAD_EXPIRED: o storage respondeu `NoSuchUpload`; o vídeo passa a `failed` com `failure_reason = 'UPLOAD_EXPIRED'` (per `phase-03-videos/TD-13` revision 2026-10-14)
- 400 VALIDATION_ERROR: corpo inválido

---

#### GET /videos/:videoId/upload/parts (SI-03.6)

Lista as partes já recebidas pelo storage (`ListParts`) para o cliente retomar o upload enviando só as que faltam (per `phase-03-videos/TD-06`).

**Response 200:**
- part_size_bytes: number
- part_count: number
- uploaded_parts: `{ part_number: number, etag: string, size_bytes: number }[]`

**Error responses:**
- 404 VIDEO_NOT_FOUND: vídeo inexistente ou de outro canal
- 409 INVALID_UPLOAD_STATE: `status` diferente de `draft`
- 410 UPLOAD_EXPIRED: idem ao endpoint anterior

---

#### POST /videos/:videoId/upload/complete (SI-03.7)

Finaliza o multipart, confere o objeto montado e enfileira o processamento. Idempotente: chamado de novo após sucesso, devolve o vídeo no estado atual sem reenfileirar (per `phase-03-videos/TD-07`).

**Request headers:**
- Content-Type: application/json

**Request body:**
- parts: `{ part_number: integer, etag: string }[]`, required — 1..`part_count` itens, `part_number` únicos

**Response 200:**
- `VideoResponseDto` (status `processing`; ou o estado atual quando o vídeo já tinha saído de `draft` por um complete anterior)

**Error responses:**
- 404 VIDEO_NOT_FOUND: vídeo inexistente ou de outro canal
- 409 INVALID_UPLOAD_STATE: `status = 'failed'`
- 400 INVALID_UPLOAD_PARTS: o storage rejeitou a lista (`InvalidPart`, `InvalidPartOrder`, `EntityTooSmall`); o multipart continua aberto e o cliente pode corrigir e repetir
- 400 VIDEO_TOO_LARGE: o objeto montado (`HeadObject.ContentLength`) excede `VIDEO_MAX_SIZE_BYTES`; o objeto é removido e o vídeo vai para `failed` com `failure_reason = 'FILE_TOO_LARGE'`
- 410 UPLOAD_EXPIRED: `NoSuchUpload` (mesma transição dos endpoints anteriores)
- 400 VALIDATION_ERROR: corpo inválido

---

#### POST /videos/:videoId/upload/restart (SI-03.8)

Reabre o upload de um vídeo cujo multipart expirou: novo `CreateMultipartUpload` na mesma `storage_key`, mesmo `public_id`, `status` volta a `draft` (per `phase-03-videos/TD-13` revision 2026-10-14).

**Request body:**
- size_bytes: integer, optional — novo tamanho declarado (mesmas regras do `POST /videos`); quando omitido, mantém o anterior e recalcula `part_count`

**Response 200:**
- video: `VideoResponseDto` (status `draft`)
- upload: `UploadSessionDto`

**Error responses:**
- 404 VIDEO_NOT_FOUND: vídeo inexistente ou de outro canal
- 409 INVALID_UPLOAD_STATE: vídeo não está em `failed` com `failure_reason = 'UPLOAD_EXPIRED'`
- 400 VIDEO_TOO_LARGE: `size_bytes` acima do limite
- 400 VALIDATION_ERROR: corpo inválido

---

#### DELETE /videos/:videoId (SI-03.8)

Exclui um vídeo que não chegou a ser processado: aborta o multipart se houver, remove os objetos do prefixo `videos/{id}/` e apaga a linha (per `phase-03-videos/TD-13` revision 2026-10-14). Excluir vídeos `processing`/`ready` é gerenciamento de vídeo, da Fase 04.

**Response 204:** No content.

**Error responses:**
- 404 VIDEO_NOT_FOUND: vídeo inexistente ou de outro canal
- 409 INVALID_UPLOAD_STATE: `status` é `processing` ou `ready`

---

#### GET /videos/:videoId (SI-03.11)

Detalhe do vídeo para o dono, para acompanhar o processamento (per `phase-03-videos/TD-12` revision 2026-10-14). Listagens ficam para a Fase 04.

**Response 200:**
- `VideoResponseDto`

**Error responses:**
- 404 VIDEO_NOT_FOUND: vídeo inexistente ou de outro canal

---

#### GET /videos/:videoId/stream (SI-03.11)

Devolve uma URL GET pré-assinada do arquivo original; o storage atende `Range` com `206 Partial Content`, então o player começa a tocar sem baixar o arquivo inteiro (per `phase-03-videos/TD-11`).

**Response 200:**
- url: string — URL GET pré-assinada (TTL `VIDEO_PLAYBACK_URL_TTL_SECONDS`)
- expires_at: string (ISO-8601)

**Error responses:**
- 404 VIDEO_NOT_FOUND: vídeo inexistente ou de outro canal
- 409 VIDEO_NOT_READY: `status` diferente de `ready`

---

#### GET /videos/:videoId/download (SI-03.11)

Igual ao `stream`, mas a URL assinada inclui `ResponseContentDisposition: attachment; filename="{original_filename}"`, forçando o download (per `phase-03-videos/TD-11`).

**Response 200:**
- url: string
- expires_at: string (ISO-8601)

**Error responses:**
- 404 VIDEO_NOT_FOUND: vídeo inexistente ou de outro canal
- 409 VIDEO_NOT_READY: `status` diferente de `ready`

---

#### Validation Rules — Videos

- `filename`: required, string, 1..255
- `mime_type`: required, um de `video/mp4`, `video/quicktime`, `video/webm`, `video/x-matroska` (falha → domínio `UNSUPPORTED_MEDIA_TYPE`, não `VALIDATION_ERROR`, para o cliente distinguir)
- `size_bytes`: required, inteiro ≥ 1; acima de `VIDEO_MAX_SIZE_BYTES` → domínio `VIDEO_TOO_LARGE`
- `title`: optional, string, 1..100
- `part_numbers`: required, array 1..100 de inteiros ≥ 1, sem repetição
- `parts`: required, array ≥ 1 de `{ part_number: integer ≥ 1, etag: string não vazia }`, sem `part_number` repetido
- `:videoId`: string de 11 chars no alfabeto base64url (`[A-Za-z0-9_-]{11}`); formato inválido → `404 VIDEO_NOT_FOUND` (não vaza diferença entre "mal formado" e "inexistente")

### Authorization Matrix

Nesta fase todo vídeo é rascunho; só o dono do canal enxerga ou opera sobre ele (per `phase-03-videos/TD-12`). A Fase 04 adiciona regras de visibilidade (público/unlisted) sem alterar as linhas abaixo.

| Endpoint | Anonymous | Authenticated (não dono) | Owner | Notes |
|----------|-----------|--------------------------|-------|-------|
| POST /videos | ✗ (401) | ✓ | — | O vídeo é criado no canal do próprio usuário |
| POST /videos/:videoId/upload/part-urls | ✗ (401) | ✗ (404) | ✓ | |
| GET /videos/:videoId/upload/parts | ✗ (401) | ✗ (404) | ✓ | |
| POST /videos/:videoId/upload/complete | ✗ (401) | ✗ (404) | ✓ | |
| POST /videos/:videoId/upload/restart | ✗ (401) | ✗ (404) | ✓ | |
| DELETE /videos/:videoId | ✗ (401) | ✗ (404) | ✓ | Só `draft` / `failed` |
| GET /videos/:videoId | ✗ (401) | ✗ (404) | ✓ | |
| GET /videos/:videoId/stream | ✗ (401) | ✗ (404) | ✓ | Só `ready` |
| GET /videos/:videoId/download | ✗ (401) | ✗ (404) | ✓ | Só `ready` |

Não-dono recebe `404 VIDEO_NOT_FOUND` (não `403`), para não confirmar que o `public_id` existe. A posse é resolvida por `videos.channel_id = channel.id` do usuário do token (relação 1:1 usuário ↔ canal herdada da Fase 02).

### Error Catalog

**Error response format:** herdado da Fase 02 (per `phase-02-auth/TD-07`) — `{ statusCode: number, error: string, message: string }`, com `error` carregando o código de domínio abaixo. Erros de validação seguem com `error = "VALIDATION_ERROR"`. Os códigos novos são subclasses de `DomainException` (`src/common/exceptions/`), mapeadas pelo `DomainExceptionFilter` existente.

| Code | HTTP | Message | Trigger |
|------|------|---------|---------|
| VIDEO_NOT_FOUND | 404 | Video not found | `:videoId` mal formado, inexistente ou de outro canal, em qualquer endpoint `/videos/:videoId…` |
| UNSUPPORTED_MEDIA_TYPE | 400 | Unsupported video type | `POST /videos` com `mime_type` fora da allowlist (per `phase-03-videos/TD-05` revision) |
| VIDEO_TOO_LARGE | 400 | Video exceeds the maximum allowed size | `POST /videos` / `restart` com `size_bytes` > `VIDEO_MAX_SIZE_BYTES`; ou `complete` quando o objeto montado excede o limite (per `phase-03-videos/TD-07`) |
| INVALID_UPLOAD_STATE | 409 | Operation not allowed in the current video status | Operação de upload fora do `status` permitido (part-urls/parts/complete fora de `draft`; restart fora de `failed`+`UPLOAD_EXPIRED`; delete em `processing`/`ready`) (per `phase-03-videos/TD-13`) |
| INVALID_PART_NUMBER | 400 | Part number out of range | `part-urls` com número fora de `1..part_count` (per `phase-03-videos/TD-06`) |
| INVALID_UPLOAD_PARTS | 400 | Uploaded parts are invalid or incomplete | `complete` quando o storage rejeita a lista de partes (`InvalidPart`, `InvalidPartOrder`, `EntityTooSmall`) |
| UPLOAD_EXPIRED | 410 | Upload session expired | Operação de upload recebe `NoSuchUpload` do storage; o vídeo vira `failed` (`UPLOAD_EXPIRED`) (per `phase-03-videos/TD-13` revision 2026-10-14) |
| VIDEO_NOT_READY | 409 | Video is not ready | `stream` / `download` com `status` ≠ `ready` (per `phase-03-videos/TD-11`, `phase-03-videos/TD-12`) |

**Processing failure reasons** (gravadas em `videos.failure_reason`, não são respostas HTTP):

| failure_reason | Origem | Trigger |
|----------------|--------|---------|
| UPLOAD_EXPIRED | API | `NoSuchUpload` numa operação de upload sobre vídeo `draft` (per `phase-03-videos/TD-13` revision) |
| FILE_TOO_LARGE | API | Objeto montado no `complete` excede `VIDEO_MAX_SIZE_BYTES` (per `phase-03-videos/TD-07`) |
| INVALID_MEDIA | Worker | ffprobe não encontra stream de vídeo válido → `UnrecoverableError`, sem retry (per `phase-03-videos/TD-14`, `phase-03-videos/TD-05` revision) |
| PROCESSING_FAILED | Worker | Última tentativa do job falha por erro transitório (storage, rede, ffmpeg) (per `phase-03-videos/TD-14`) |

### Events/Messages

#### video-processing → process-video

Fila BullMQ `video-processing`, job `process-video` (per `phase-03-videos/TD-01`).

**Payload:**

```json
{ "videoId": "uuid" }
```

`videoId` é o `videos.id` interno (não o `public_id`).

**Producer:** `VideoProcessingQueue` (API, chamado por `VideoUploadsService.complete`) (per `phase-03-videos/TD-07`)
**Consumer:** `VideoProcessingProcessor` (`@Processor('video-processing')` no processo do worker, entrypoint próprio e serviço `video-worker` no Compose) (per `phase-03-videos/TD-02`)
**Trigger:** `POST /videos/:videoId/upload/complete` bem-sucedido, depois que o `status` vira `processing`.
**Job options:** `jobId = videoId` (dedup por vídeo); `attempts: VIDEO_PROCESSING_ATTEMPTS` (default 3); `backoff: { type: 'exponential', delay: VIDEO_PROCESSING_BACKOFF_MS }` (default 10000); `removeOnComplete` / `removeOnFail` por contagem (per `phase-03-videos/TD-01`, `phase-03-videos/TD-14`).
**Delivery semantics:** at-least-once. O processor é idempotente: ignora (completa sem efeito) jobs cujo vídeo não está mais em `processing`, e regravar metadados/thumbnail na mesma chave é seguro (per `phase-03-videos/TD-14`).
**Processing contract (worker):**
1. Carrega o vídeo por `id`; se não existir ou `status` ≠ `processing`, encerra sem erro.
2. Assina uma URL GET contra o endpoint **interno** do storage, com TTL maior que a duração máxima do job, e a usa como `-i` do ffprobe/ffmpeg (leituras por range, sem baixar o arquivo) (per `phase-03-videos/TD-04`).
3. `ffprobe -v error -print_format json -show_format -show_streams`; sem stream de vídeo → `UnrecoverableError` → `failed` / `INVALID_MEDIA` (per `phase-03-videos/TD-03`, `phase-03-videos/TD-14`).
4. Extrai `duration_seconds`, `width`, `height`, `video_codec`, `size_bytes` e o resumo `metadata` (per `phase-03-videos/TD-03` revision 2026-10-14).
5. Gera o thumbnail: frame em 10% da duração, JPEG com largura máxima de 1280px mantendo a proporção; se falhar, frame 0 (per `phase-03-videos/TD-03` revision 2026-10-14). Grava em `videos/{id}/thumbnail.jpg`.
6. Numa única atualização: grava metadados + `thumbnail_key`, `status = 'ready'`, `failure_reason = null`.
7. Em falha transitória, relança o erro para o BullMQ reagendar; na última tentativa (`attemptsMade` atingindo `opts.attempts`), grava `status = 'failed'` / `PROCESSING_FAILED` antes de relançar (per `phase-03-videos/TD-14`).

---

## Dependency Map

```
SI-03.1 (root — deps, ffmpeg na imagem, redis + minio no Compose)
├── SI-03.2 — depends on SI-03.1 (config aponta para os serviços novos)
│   ├── SI-03.3 — depends on SI-03.2 (namespace storage)
│   │   ├── SI-03.10 — depends on SI-03.1 + SI-03.3 (ffmpeg na imagem; URL interna pré-assinada nos testes)
│   │   └── SI-03.6 — depends on SI-03.3 + SI-03.4 (multipart + entidade Video)
│   │       └── SI-03.7 — depends on SI-03.6 (vídeo draft com multipart aberto)
│   │           ├── SI-03.8 — depends on SI-03.7 + SI-03.5 (partes enviadas + producer da fila)
│   │           ├── SI-03.9 — depends on SI-03.7 (transição UPLOAD_EXPIRED + findOwnedByPublicId)
│   │           └── SI-03.12 — depends on SI-03.7 + SI-03.3 (findOwnedByPublicId + presignGet)
│   └── SI-03.5 — depends on SI-03.2 + SI-03.1 (namespaces queue/videos + serviço redis)
SI-03.4 (root — entidade Video, migration, public ID; depende só da Fase 02)

SI-03.10 + SI-03.5 + SI-03.3 + SI-03.4 + SI-03.8
└── SI-03.11 — worker consome o job que o complete enfileira

SI-03.6 + SI-03.7 + SI-03.8 + SI-03.9 + SI-03.11 + SI-03.12
└── SI-03.13 — OpenAPI + CLAUDE.md refletem tudo que foi implementado
```

---

## Deliverables

- [ ] SI-03.1 — Infra: dependências, imagem com FFmpeg e serviços Redis/MinIO no Compose
- [ ] SI-03.2 — Configurar namespaces de storage, fila e vídeos
- [ ] SI-03.3 — Implementar StorageModule (S3 multipart, presign e objetos)
- [ ] SI-03.4 — Criar entidade Video, migration CreateVideos e gerador de ID público
- [ ] SI-03.5 — Configurar a fila BullMQ e o producer `video-processing`
- [ ] SI-03.6 — Endpoint POST /videos (pré-cadastro do rascunho e abertura do upload)
- [ ] SI-03.7 — Endpoints de assinatura de partes e retomada do upload
- [ ] SI-03.8 — Endpoint de conclusão do upload com enfileiramento do processamento
- [ ] SI-03.9 — Endpoints de reinício do upload expirado e exclusão do vídeo não processado
- [ ] SI-03.10 — Implementar o serviço de mídia (ffprobe e thumbnail via FFmpeg)
- [ ] SI-03.11 — Implementar o worker de vídeo (entrypoint, processor e serviço no Compose)
- [ ] SI-03.12 — Endpoints de detalhe, streaming e download do vídeo
- [ ] SI-03.13 — Atualizar o contrato OpenAPI e a documentação de IA (seção de vídeos)

**Full test suites:**

- [ ] Infra sobe e fica saudável (`cd nestjs-project && docker compose up -d && docker compose ps`) — `db`, `mailpit`, `redis`, `minio`, `nestjs-api` e `video-worker` em execução
- [ ] Backend tests pass (`cd nestjs-project && docker compose exec nestjs-api npm test -- --runInBand`)
- [ ] E2E tests pass (`cd nestjs-project && docker compose exec nestjs-api npm run test:e2e`)
- [ ] Type/compilation checks pass (`cd nestjs-project && docker compose exec nestjs-api npx tsc --noEmit`)
- [ ] Lint passes (`cd nestjs-project && docker compose exec nestjs-api npm run lint`)
