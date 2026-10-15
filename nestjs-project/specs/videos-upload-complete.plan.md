---
subproject: backend
runner: jest+supertest
scope: phase-03-videos
si: SI-03.8
target_file: test/videos-upload-complete.e2e-spec.ts
---

# POST /videos/:videoId/upload/complete — Test Plan

## Application Overview

`complete` fecha o multipart no storage, confere o tamanho real do objeto montado (`HeadObject`) contra `VIDEO_MAX_SIZE_BYTES` e, se estiver tudo certo, passa o vídeo para `processing` e enfileira o job `process-video` na fila BullMQ `video-processing`, com `jobId` igual ao uuid interno do vídeo. A chamada é idempotente: repetida sobre um vídeo em `processing`, só reenfileira (o `jobId` deduplica) e devolve o estado atual. Se o storage rejeita as partes, o vídeo continua `draft` e o cliente pode corrigir e repetir. Se o objeto passa do limite, ele é removido e o vídeo vai para `failed` / `FILE_TOO_LARGE`. Se o multipart expirou, a API faz a mesma transição para `UPLOAD_EXPIRED` do SI-03.7.

## Test Scenarios

### 1. Conclusão do upload com enfileiramento do processamento

**Setup:** `beforeAll`: `Test.createTestingModule({ imports: [AppModule] }).compile()`, com `ValidationPipe` global e `DomainExceptionFilter` + `ValidationExceptionFilter` (mesmo bootstrap de `test/auth.e2e-spec.ts`); obter `DataSource`, o repositório de `Video`, o `StorageService` e a `Queue` de `video-processing` (`app.get(getQueueToken('video-processing'))`, prefixo `bull-test` via `src/test/setup-test-env.ts`; nenhum worker consome a fila nesta suíte). `beforeEach`: `cleanAllTables(dataSource)` + `storageService.deletePrefix('videos/')` + `queue.obliterate({ force: true })`; criar o usuário dono (helper `registerConfirmAndLogin`); como dono, `POST /videos` com `{ filename: "aula.mp4", mime_type: "video/mp4", size_bytes: 1024 }` (`part_count = 1`), assinar a parte 1 via `part-urls`, enviar `Buffer.alloc(1024, 1)` por `PUT` na URL (host de `S3_PUBLIC_ENDPOINT` alcançável do container de testes) e guardar `videoId` e o `ETag`. `afterAll`: `app.close()` (fecha as conexões Redis da fila).

#### 1.1. conclui-upload-e-enfileira-job

**Covers AC:** #1
**Source:** auto
**Last sync:** 2026-10-14T22:42:38Z

**Steps:**
  1. POST /videos/:videoId/upload/complete como dono, com `{ parts: [{ part_number: 1, etag: <ETag> }] }`
    - expect: status `200`
    - expect: `body.status === "processing"` e `body.id === videoId`
  2. Recarregar a linha do vídeo
    - expect: `status = 'processing'`, `upload_id = null`, `size_bytes = 1024` (confirmado pelo `HeadObject`)
  3. `storageService.headObject('videos/{id}/original')`, onde `{id}` é o uuid da linha
    - expect: o objeto existe com `contentLength = 1024`
  4. `queue.getJob(<uuid da linha>)`
    - expect: o job existe, com `name === "process-video"` e `data` igual a `{ videoId: <uuid da linha> }`

#### 1.2. complete-repetido-e-idempotente

**Covers AC:** #2
**Source:** auto
**Last sync:** 2026-10-14T22:42:38Z

**Steps:**
  1. POST .../upload/complete como dono com as partes corretas
    - expect: status `200` com `body.status === "processing"`
  2. Repetir exatamente a mesma chamada
    - expect: status `200` com o vídeo no estado atual (`body.status === "processing"`)
  3. Listar os jobs da fila (`queue.getJobs(['waiting', 'delayed', 'active', 'prioritized'])`) e filtrar por `id === <uuid da linha>`
    - expect: exatamente 1 job para o vídeo

#### 1.3. etag-errado-mantem-draft-e-permite-repetir

**Covers AC:** #3
**Source:** auto
**Last sync:** 2026-10-14T22:42:38Z

**Steps:**
  1. POST .../upload/complete como dono, com `{ parts: [{ part_number: 1, etag: "\"00000000000000000000000000000000\"" }] }`
    - expect: status `400`
    - expect: `body.error === "INVALID_UPLOAD_PARTS"`
  2. Recarregar a linha do vídeo
    - expect: `status = 'draft'` e `upload_id` inalterado
  3. Repetir o `complete` com o `ETag` correto
    - expect: status `200` com `body.status === "processing"`

#### 1.4. objeto-acima-do-limite-vira-file-too-large

**Covers AC:** #4
**Source:** auto
**Last sync:** 2026-10-14T22:42:38Z

**Steps:**
  1. Subir uma segunda instância da aplicação (mesmo bootstrap) com `.overrideProvider(videosConfig.KEY).useValue({ ...valoresPadrão, maxSizeBytes: 512 })`. Montar 10GB reais é inviável no teste, e só a config muda: nenhum serviço é mockado
  2. Nessa instância, como dono: `POST /videos` com `{ filename: "aula.mp4", mime_type: "video/mp4", size_bytes: 512 }`, assinar a parte 1 e enviar `Buffer.alloc(1024, 1)` por `PUT` (o objeto montado fica maior que o declarado e que o limite)
  3. POST .../upload/complete com a parte e o `ETag` corretos
    - expect: status `400`
    - expect: `body.error === "VIDEO_TOO_LARGE"`
  4. Recarregar a linha e consultar o storage
    - expect: `status = 'failed'` e `failure_reason = 'FILE_TOO_LARGE'`
    - expect: nenhum objeto resta sob `videos/{id}/` (`headObject` do original falha com not found)
    - expect: nenhum job na fila para o uuid do vídeo
  5. Fechar a segunda instância

#### 1.5. complete-em-video-failed-retorna-409

**Covers AC:** #5
**Source:** auto
**Last sync:** 2026-10-14T22:42:38Z

**Steps:**
  1. Atualizar a linha para `status = 'failed'` e `failure_reason = 'INVALID_MEDIA'` direto no repositório
  2. POST .../upload/complete como dono com as partes corretas
    - expect: status `409`
    - expect: `body.error === "INVALID_UPLOAD_STATE"`
    - expect: nenhum job na fila para o uuid do vídeo

#### 1.6. multipart-expirado-retorna-410

**Covers AC:** #6
**Source:** auto
**Last sync:** 2026-10-14T22:42:38Z

**Steps:**
  1. `storageService.abortMultipartUpload(storage_key, upload_id)` direto no storage, com os valores da linha
  2. POST .../upload/complete como dono com as partes e o `ETag` do setup
    - expect: status `410`
    - expect: `body.error === "UPLOAD_EXPIRED"`
  3. Recarregar a linha
    - expect: `status = 'failed'`, `failure_reason = 'UPLOAD_EXPIRED'`, `upload_id = null`
    - expect: nenhum job na fila para o uuid do vídeo
