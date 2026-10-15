---
subproject: backend
runner: jest+supertest
scope: phase-03-videos
si: SI-03.9
target_file: test/videos-upload-restart-delete.e2e-spec.ts
---

# POST /videos/:videoId/upload/restart + DELETE /videos/:videoId — Test Plan

## Application Overview

Os dois endpoints cuidam do upload interrompido. O `restart` reabre o upload de um vídeo `failed` / `UPLOAD_EXPIRED`: abre um novo multipart na mesma `storage_key`, mantém o mesmo `public_id` (a URL não muda) e devolve o vídeo em `draft` com um `UploadSessionDto` novo. Esse `size_bytes` é opcional e segue as mesmas regras do `POST /videos`. O `DELETE` exclui um vídeo que não chegou a ser processado (`draft` ou `failed`): aborta o multipart, se houver, remove tudo sob `videos/{id}/` e apaga a linha. Vídeos `processing` ou `ready` ficam para o gerenciamento da Fase 04 e recebem `409`. Quem não é dono recebe `404 VIDEO_NOT_FOUND`.

## Test Scenarios

### 1. Reinício do upload expirado e exclusão do vídeo não processado

**Setup:** `beforeAll`: `Test.createTestingModule({ imports: [AppModule] }).compile()`, com `ValidationPipe` global e `DomainExceptionFilter` + `ValidationExceptionFilter` (mesmo bootstrap de `test/auth.e2e-spec.ts`); obter `DataSource`, o repositório de `Video` e o `StorageService`. `beforeEach`: `cleanAllTables(dataSource)` + `storageService.deletePrefix('videos/')`; criar o usuário dono e um segundo usuário (helper `registerConfirmAndLogin`); como dono, `POST /videos` com `{ filename: "aula.mp4", mime_type: "video/mp4", size_bytes: 314572800 }` e guardar `videoId`. Helper `expireUpload(videoId)`: `abortMultipartUpload` direto no storage seguido de `GET .../upload/parts` (espera `410`), deixando o vídeo `failed` / `UPLOAD_EXPIRED` pelo caminho real da API. Os `PUT` em URLs assinadas saem do container de testes (`S3_PUBLIC_ENDPOINT=http://minio:9000`, nome do serviço do Compose, per `phase-03-videos/TD-09` revision 2026-10-14). `afterAll`: `app.close()`.

#### 1.1. restart-reabre-upload-expirado-na-mesma-url

**Covers AC:** #1
**Source:** auto
**Last sync:** 2026-10-15T00:47:15Z

**Steps:**
  1. `expireUpload(videoId)` e guardar o `upload_id` antigo
    - expect: a linha fica com `status = 'failed'` e `failure_reason = 'UPLOAD_EXPIRED'`
  2. POST /videos/:videoId/upload/restart como dono, com `{ size_bytes: 209715200 }`
    - expect: status `200`
    - expect: `body.video.status === "draft"`, `body.video.id === videoId` e `body.video.failure_reason === null`
    - expect: `body.upload` igual a `{ part_size_bytes: 104857600, part_count: 2 }`
  3. Recarregar a linha
    - expect: `upload_id` não nulo e diferente do antigo; `storage_key` inalterada; `size_bytes = 209715200`
  4. `part-urls` com `{ part_numbers: [1] }` e `PUT` de `Buffer.alloc(1024, 1)` na URL
    - expect: `part-urls` com `200`; `PUT` com `200` e `ETag`
  5. GET .../upload/parts
    - expect: `200` com `uploaded_parts` contendo `part_number: 1`

#### 1.2. restart-fora-de-upload-expirado-retorna-409

**Covers AC:** #2
**Source:** auto
**Last sync:** 2026-10-15T00:47:15Z

**Steps:**
  1. Com o vídeo em `draft` (estado do setup), POST .../upload/restart como dono com `{}`
    - expect: status `409` e `body.error === "INVALID_UPLOAD_STATE"`
  2. Para cada estado `{ status: 'failed', failure_reason: 'INVALID_MEDIA' }`, `{ status: 'processing' }` e `{ status: 'ready' }`, atualizar a linha direto no repositório e chamar POST .../upload/restart como dono com `{}`
    - expect: status `409` e `body.error === "INVALID_UPLOAD_STATE"` em todos os casos
    - expect: `status`, `failure_reason` e `upload_id` da linha inalterados depois de cada chamada

#### 1.3. delete-de-rascunho-remove-tudo

**Covers AC:** #3
**Source:** auto
**Last sync:** 2026-10-15T00:47:15Z

**Steps:**
  1. Assinar a parte 1 e enviar 1024 bytes por `PUT`; guardar `storage_key`, `upload_id` e o uuid da linha
  2. DELETE /videos/:videoId como dono
    - expect: status `204` com corpo vazio
  3. Consultar a tabela `videos` pelo uuid
    - expect: a linha não existe mais
  4. `storageService.listParts(storage_key, upload_id)` com os valores guardados
    - expect: rejeita com `StorageUploadNotFoundError` (multipart abortado)
  5. Listar os objetos sob `videos/{id}/` no bucket de teste
    - expect: nenhum objeto

#### 1.4. delete-de-video-processing-ou-ready-retorna-409

**Covers AC:** #4
**Source:** auto
**Last sync:** 2026-10-15T00:47:15Z

**Steps:**
  1. Gravar um objeto em `videos/{id}/original` com `storageService.putObject` e atualizar a linha para `status = 'ready'`
  2. DELETE /videos/:videoId como dono
    - expect: status `409` e `body.error === "INVALID_UPLOAD_STATE"`
    - expect: a linha continua na tabela e `headObject('videos/{id}/original')` ainda encontra o objeto
  3. Atualizar a linha para `status = 'processing'` e repetir o DELETE
    - expect: status `409` e `body.error === "INVALID_UPLOAD_STATE"`
    - expect: a linha e o objeto continuam existindo

#### 1.5. restart-e-delete-de-outro-usuario-retornam-404

**Covers AC:** #5
**Source:** auto
**Last sync:** 2026-10-15T00:47:15Z

**Steps:**
  1. `expireUpload(videoId)` e POST /videos/:videoId/upload/restart com o token do segundo usuário
    - expect: status `404` e `body.error === "VIDEO_NOT_FOUND"`
    - expect: a linha continua `failed` / `UPLOAD_EXPIRED`
  2. DELETE /videos/:videoId com o token do segundo usuário
    - expect: status `404` e `body.error === "VIDEO_NOT_FOUND"`
    - expect: a linha continua na tabela
  3. POST .../upload/restart e DELETE sem header `Authorization`
    - expect: status `401` nos dois (Authorization Matrix)
