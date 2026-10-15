---
subproject: backend
runner: jest+supertest
scope: phase-03-videos
si: SI-03.6
target_file: test/videos-create.e2e-spec.ts
---

# POST /videos — Test Plan

## Application Overview

`POST /videos` inicia o upload direto ao storage: na mesma operação, cria o vídeo como rascunho (`status = 'draft'`) no canal do usuário autenticado e abre um multipart upload do S3 em `videos/{id}/original`. A resposta traz o que o cliente precisa para enviar as partes (`upload = { part_size_bytes, part_count }`) e o `VideoResponseDto`, cujo `id` é o `public_id` de 11 chars. O `upload_id`, a `storage_key` e o uuid interno nunca saem da API. `mime_type` fora da allowlist e `size_bytes` acima de `VIDEO_MAX_SIZE_BYTES` são erros de domínio (`UNSUPPORTED_MEDIA_TYPE` e `VIDEO_TOO_LARGE`), distintos do `VALIDATION_ERROR` do DTO.

## Test Scenarios

### 1. POST /videos — pré-cadastro do rascunho e abertura do upload

**Setup:** `beforeAll`: `Test.createTestingModule({ imports: [AppModule] }).compile()`, com `ValidationPipe` global (`whitelist`, `forbidNonWhitelisted`, `transform`) e `DomainExceptionFilter` + `ValidationExceptionFilter` (mesmo bootstrap de `test/auth.e2e-spec.ts`); obter `DataSource`, o repositório de `Video` e o `StorageService`. `beforeEach`: `cleanAllTables(dataSource)` + `storageService.deletePrefix('videos/')` no bucket de teste (`streamtube-videos-test`, forçado por `src/test/setup-test-env.ts`); criar o usuário dono via registro + confirmação + `POST /auth/login` (helper `registerConfirmAndLogin`, como em `test/auth.e2e-spec.ts`) e guardar o `access_token`. `afterAll`: `app.close()`.

#### 1.1. cria-rascunho-e-abre-multipart

**Covers AC:** #1, #2, #7
**Source:** auto
**Last sync:** 2026-10-15T00:47:15Z

**Steps:**
  1. POST /videos com `Authorization: Bearer <access_token>` e body `{ filename: "aula.mp4", mime_type: "video/mp4", size_bytes: 314572800 }`
    - expect: status `201`
    - expect: `body.video.status === "draft"`, `body.video.title === "aula"`, `body.video.original_filename === "aula.mp4"`, `body.video.mime_type === "video/mp4"`, `body.video.size_bytes === 314572800` (number, não string)
    - expect: `body.video.id` casa `/^[A-Za-z0-9_-]{11}$/`
    - expect: `body.upload` igual a `{ part_size_bytes: 104857600, part_count: 3 }`
    - expect: `body.video.thumbnail_url`, `duration_seconds`, `width`, `height`, `video_codec` e `failure_reason` são `null`
  2. Inspecionar o corpo da resposta inteiro
    - expect: nenhuma chave `upload_id`, `storage_key`, `channel_id` ou `public_id` em `body`, `body.video` ou `body.upload`
    - expect: nenhum valor no formato uuid em `body.video` (o `id` interno não vaza)
  3. Consultar a tabela `videos` por `public_id = body.video.id`
    - expect: existe exatamente uma linha, com `status = 'draft'`, `channel_id` igual ao canal do usuário dono, `storage_key = videos/{id}/original` (onde `{id}` é o uuid da linha), `upload_id` não nulo, `part_size_bytes = 104857600` e `part_count = 3`
  4. Chamar `storageService.listParts(storage_key, upload_id)` com os valores da linha
    - expect: resolve sem erro com lista vazia (o multipart está aberto no storage)

#### 1.2. mime-fora-da-allowlist-rejeitado

**Covers AC:** #3
**Source:** auto
**Last sync:** 2026-10-15T00:47:15Z

**Steps:**
  1. POST /videos autenticado com `{ filename: "foto.png", mime_type: "image/png", size_bytes: 1024 }`
    - expect: status `400`
    - expect: `body.error === "UNSUPPORTED_MEDIA_TYPE"` e `body.statusCode === 400`
  2. Contar as linhas da tabela `videos`
    - expect: `0`

#### 1.3. tamanho-acima-do-limite-rejeitado

**Covers AC:** #4
**Source:** auto
**Last sync:** 2026-10-15T00:47:15Z

**Steps:**
  1. POST /videos autenticado com `{ filename: "grande.mp4", mime_type: "video/mp4", size_bytes: 10737418241 }`
    - expect: status `400`
    - expect: `body.error === "VIDEO_TOO_LARGE"`
  2. Contar as linhas da tabela `videos`
    - expect: `0`

#### 1.4. corpo-invalido-sem-filename

**Covers AC:** #5
**Source:** auto
**Last sync:** 2026-10-15T00:47:15Z

**Steps:**
  1. POST /videos autenticado com `{ mime_type: "video/mp4", size_bytes: 1024 }` (sem `filename`)
    - expect: status `400`
    - expect: `body.error === "VALIDATION_ERROR"`
  2. Contar as linhas da tabela `videos`
    - expect: `0`

#### 1.5. sem-token-retorna-401

**Covers AC:** #6
**Source:** auto
**Last sync:** 2026-10-15T00:47:15Z

**Steps:**
  1. POST /videos sem header `Authorization`, com body válido `{ filename: "aula.mp4", mime_type: "video/mp4", size_bytes: 1024 }`
    - expect: status `401`
  2. Contar as linhas da tabela `videos`
    - expect: `0`
