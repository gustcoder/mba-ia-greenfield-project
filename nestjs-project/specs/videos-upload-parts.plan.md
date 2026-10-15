---
subproject: backend
runner: jest+supertest
scope: phase-03-videos
si: SI-03.7
target_file: test/videos-upload-parts.e2e-spec.ts
---

# POST /videos/:videoId/upload/part-urls + GET /videos/:videoId/upload/parts — Test Plan

## Application Overview

Os dois endpoints mantêm o envio das partes fora da API. O `part-urls` assina, sob demanda, URLs `PUT` de `UploadPart` para os números de parte pedidos, com prazo em `expires_at`. O `parts` lista as partes que o storage já recebeu (`ListParts`), para o cliente retomar o envio depois de uma queda. Os dois exigem vídeo `draft` do próprio dono. Se o vídeo é de outro canal, não existe ou tem `:videoId` mal formado, a resposta é sempre `404 VIDEO_NOT_FOUND`. Quando o storage responde `NoSuchUpload`, a API detecta a expiração naquele momento: grava o vídeo como `failed` / `UPLOAD_EXPIRED` e responde `410`.

## Test Scenarios

### 1. Assinatura de partes e retomada do upload

**Setup:** `beforeAll`: `Test.createTestingModule({ imports: [AppModule] }).compile()`, com `ValidationPipe` global e `DomainExceptionFilter` + `ValidationExceptionFilter` (mesmo bootstrap de `test/auth.e2e-spec.ts`); obter `DataSource`, o repositório de `Video` e o `StorageService`. `beforeEach`: `cleanAllTables(dataSource)` + `storageService.deletePrefix('videos/')` no bucket de teste; criar o usuário dono e um segundo usuário (helper `registerConfirmAndLogin`); como dono, `POST /videos` com `{ filename: "aula.mp4", mime_type: "video/mp4", size_bytes: 314572800 }` (`part_count = 3`) e guardar `body.video.id` como `videoId`. Os `PUT` nas URLs assinadas saem do container de testes, então o host de `S3_PUBLIC_ENDPOINT` precisa ser alcançável dali (ver a nota de ambiente no SI-03.2: em teste, `http://minio:9000`). `afterAll`: `app.close()`.

#### 1.1. assina-urls-e-storage-aceita-put

**Covers AC:** #1
**Source:** auto
**Last sync:** 2026-10-14T22:42:38Z

**Steps:**
  1. POST /videos/:videoId/upload/part-urls como dono, com `{ part_numbers: [1, 2] }`
    - expect: status `200`
    - expect: `body.parts` tem 2 itens, `part_number` 1 e 2, cada um com `url` string
    - expect: `body.expires_at` é ISO-8601 no futuro
  2. `fetch(body.parts[0].url, { method: 'PUT', body: Buffer.alloc(1024, 1) })`, direto no storage, sem passar pela API
    - expect: status `200` do storage
    - expect: header `ETag` presente e não vazio

#### 1.2. lista-partes-enviadas-para-retomada

**Covers AC:** #2
**Source:** auto
**Last sync:** 2026-10-14T22:42:38Z

**Steps:**
  1. Assinar a parte 1 (`part-urls` com `{ part_numbers: [1] }`) e enviar 1024 bytes por `PUT` na URL, guardando o `ETag`
    - expect: `PUT` com status `200`
  2. GET /videos/:videoId/upload/parts como dono
    - expect: status `200`
    - expect: `body.part_size_bytes === 104857600` e `body.part_count === 3`
    - expect: `body.uploaded_parts` tem exatamente um item com `part_number: 1`, `etag` igual ao `ETag` do `PUT` (comparar sem as aspas) e `size_bytes: 1024`

#### 1.3. numero-de-parte-fora-do-intervalo

**Covers AC:** #3
**Source:** auto
**Last sync:** 2026-10-14T22:42:38Z

**Steps:**
  1. POST .../upload/part-urls como dono, com `{ part_numbers: [4] }` (acima de `part_count = 3`)
    - expect: status `400`
    - expect: `body.error === "INVALID_PART_NUMBER"`
  2. POST .../upload/part-urls como dono, com `{ part_numbers: [0] }`
    - expect: status `400`
    - expect: `body.error === "INVALID_PART_NUMBER"` (o AC #3 exige o código de domínio também para `0`; o DTO não pode barrar `0` antes com `VALIDATION_ERROR`)

#### 1.4. video-fora-de-draft-retorna-409

**Covers AC:** #4
**Source:** auto
**Last sync:** 2026-10-14T22:42:38Z

**Steps:**
  1. Atualizar a linha do vídeo para `status = 'processing'` direto no repositório
  2. POST .../upload/part-urls como dono, com `{ part_numbers: [1] }`
    - expect: status `409`
    - expect: `body.error === "INVALID_UPLOAD_STATE"`

#### 1.5. multipart-expirado-retorna-410-e-marca-failed

**Covers AC:** #5
**Source:** auto
**Last sync:** 2026-10-14T22:42:38Z

**Steps:**
  1. Ler `storage_key` e `upload_id` da linha e chamar `storageService.abortMultipartUpload(storage_key, upload_id)` direto no storage, simulando a expiração
  2. GET /videos/:videoId/upload/parts como dono
    - expect: status `410`
    - expect: `body.error === "UPLOAD_EXPIRED"`
  3. Recarregar a linha do vídeo
    - expect: `status = 'failed'`, `failure_reason = 'UPLOAD_EXPIRED'`, `upload_id = null`

#### 1.6. acesso-negado-404-uniforme-e-401-sem-token

**Covers AC:** #6
**Source:** auto
**Last sync:** 2026-10-14T22:42:38Z

**Steps:**
  1. GET /videos/:videoId/upload/parts com o token do segundo usuário (não dono)
    - expect: status `404` e `body.error === "VIDEO_NOT_FOUND"`
  2. GET /videos/AAAAAAAAAAA/upload/parts como dono (id bem formado e inexistente)
    - expect: status `404` e `body.error === "VIDEO_NOT_FOUND"`
  3. GET /videos/invalido!/upload/parts como dono (id mal formado)
    - expect: status `404` e `body.error === "VIDEO_NOT_FOUND"`
    - expect: os corpos dos três `404` são idênticos
  4. POST /videos/:videoId/upload/part-urls com o token do segundo usuário, com `{ part_numbers: [1] }`
    - expect: status `404` e `body.error === "VIDEO_NOT_FOUND"`
  5. GET /videos/:videoId/upload/parts e POST .../part-urls sem header `Authorization`
    - expect: status `401` nos dois (Authorization Matrix)
