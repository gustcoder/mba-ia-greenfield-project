---
subproject: backend
runner: jest+supertest
scope: phase-03-videos
si: SI-03.12
target_file: test/videos-detail-stream-download.e2e-spec.ts
---

# GET /videos/:videoId + /stream + /download — Test Plan

## Application Overview

Os três endpoints são do dono e servem para acompanhar o vídeo e consumi-lo sem que bytes passem pela API. O `GET /videos/:videoId` devolve o `VideoResponseDto` com o `status` atual. Para vídeos `ready`, o DTO traz os metadados extraídos pelo worker e um `thumbnail_url` pré-assinado. O `/stream` e o `/download` devolvem `{ url, expires_at }` com uma URL GET pré-assinada do original. O storage atende `Range` com `206`, então o player toca sem baixar o arquivo inteiro. A URL de download força `Content-Disposition: attachment` com o nome original. Os dois exigem `status = 'ready'`; fora disso, respondem `409 VIDEO_NOT_READY`.

## Test Scenarios

### 1. Detalhe, streaming e download do vídeo

**Setup:** `beforeAll`: `Test.createTestingModule({ imports: [AppModule] }).compile()`, com `ValidationPipe` global e `DomainExceptionFilter` + `ValidationExceptionFilter` (mesmo bootstrap de `test/auth.e2e-spec.ts`); obter `DataSource`, o repositório de `Video` e o `StorageService`. `beforeEach`: `cleanAllTables(dataSource)` + `storageService.deletePrefix('videos/')`; criar o usuário dono e um segundo usuário (helper `registerConfirmAndLogin`); como dono, `POST /videos` com `{ filename: "Minha Aula.mp4", mime_type: "video/mp4", size_bytes: 4096 }` e guardar `videoId`. Helper `makeReady(videoId)`: grava `Buffer.alloc(4096, 7)` em `videos/{id}/original` e um JPEG mínimo em `videos/{id}/thumbnail.jpg` via `storageService.putObject`, e atualiza a linha para `status = 'ready'`, `upload_id = null`, `thumbnail_key = videos/{id}/thumbnail.jpg`, `duration_seconds = 12.5`, `width = 1280`, `height = 720`, `video_codec = 'h264'`. Isso simula o resultado do worker, que não roda nesta suíte. As URLs assinadas são buscadas a partir do container de testes, então o host de `S3_PUBLIC_ENDPOINT` precisa ser alcançável dali. `afterAll`: `app.close()`.

#### 1.1. detalhe-reflete-status-e-metadados

**Covers AC:** #1
**Source:** auto
**Last sync:** 2026-10-14T22:42:38Z

**Steps:**
  1. GET /videos/:videoId como dono, com o vídeo ainda em `draft`
    - expect: status `200`
    - expect: `body.id === videoId`, `body.status === "draft"`, `body.thumbnail_url === null` e `body.duration_seconds === null`
  2. `makeReady(videoId)` e GET /videos/:videoId como dono
    - expect: status `200` com `body.status === "ready"`
    - expect: `body.duration_seconds === 12.5`, `body.width === 1280`, `body.height === 720` e `body.video_codec === "h264"`
    - expect: `body.thumbnail_url` é uma string não nula
  3. `fetch(body.thumbnail_url)`
    - expect: status `200` com os bytes do JPEG gravado

#### 1.2. stream-devolve-url-que-atende-range-206

**Covers AC:** #2
**Source:** auto
**Last sync:** 2026-10-14T22:42:38Z

**Steps:**
  1. `makeReady(videoId)` e GET /videos/:videoId/stream como dono
    - expect: status `200`
    - expect: `body.url` é uma string e `body.expires_at` é ISO-8601 no futuro
  2. `fetch(body.url, { headers: { Range: 'bytes=0-1023' } })`
    - expect: status `206`
    - expect: o corpo tem exatamente 1024 bytes
    - expect: header `Content-Range` começa com `bytes 0-1023/4096`

#### 1.3. download-devolve-url-com-attachment

**Covers AC:** #3
**Source:** auto
**Last sync:** 2026-10-14T22:42:38Z

**Steps:**
  1. `makeReady(videoId)` e GET /videos/:videoId/download como dono
    - expect: status `200` com `body.url` string e `body.expires_at` ISO-8601 no futuro
  2. `fetch(body.url)`
    - expect: status `200`
    - expect: header `Content-Disposition` contém `attachment` e `filename="Minha Aula.mp4"`

#### 1.4. stream-e-download-fora-de-ready-retornam-409

**Covers AC:** #4
**Source:** auto
**Last sync:** 2026-10-14T22:42:38Z

**Steps:**
  1. Para cada estado `{ status: 'draft' }` (setup), `{ status: 'processing' }` e `{ status: 'failed', failure_reason: 'PROCESSING_FAILED' }`, atualizar a linha e chamar GET .../stream e GET .../download como dono
    - expect: status `409` e `body.error === "VIDEO_NOT_READY"` nas seis chamadas

#### 1.5. outro-usuario-404-e-sem-token-401

**Covers AC:** #5
**Source:** auto
**Last sync:** 2026-10-14T22:42:38Z

**Steps:**
  1. `makeReady(videoId)` e chamar GET /videos/:videoId, GET .../stream e GET .../download com o token do segundo usuário
    - expect: status `404` e `body.error === "VIDEO_NOT_FOUND"` nos três
  2. GET /videos/AAAAAAAAAAA como dono (id inexistente)
    - expect: status `404` e `body.error === "VIDEO_NOT_FOUND"`
  3. Chamar os três endpoints sem header `Authorization`
    - expect: status `401` nos três
