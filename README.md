# 🚀 Desafio MBA Engenharia de Software com IA - Full Cycle

![Status](https://img.shields.io/badge/Status-Concluido-green?style=for-the-badge&logo=github)
![IA](https://img.shields.io/badge/Focus-AI%20Engineering-blueviolet?style=for-the-badge&logo=openai)
![FullCycle](https://img.shields.io/badge/School-FullCycle-yellow?style=for-the-badge)


# StreamTube — Plataforma de Compartilhamento de Vídeos

Projeto da disciplina **Desenvolvimento de Aplicações de IA** do MBA de Engenharia de Software com IA da [Full Cycle](https://fullcycle.com.br).

Este é um projeto greenfield desenvolvido para demonstrar como construir uma aplicação do zero utilizando IA de forma adequada no processo de desenvolvimento.

---

## Fase 03 — Upload e Processamento de Vídeos

Esta fase deu ao StreamTube a capacidade de receber vídeos de **até 10 GB**, processá-los em segundo plano e entregá-los por **streaming** e **download**. É uma entrega de **backend**: API, worker, infraestrutura e artefatos do processo (a interface de vídeo no frontend não faz parte do escopo).

### O que a fase entrega

- **Upload de até 10 GB sem segurar a API:** o arquivo vai do navegador direto para o object storage; a API só orquestra.
- **Rascunho automático:** ao iniciar o upload, o vídeo já nasce pré-cadastrado como `draft` no canal do usuário.
- **Processamento automático:** um worker separado extrai duração e metadados (ffprobe) e gera a thumbnail (ffmpeg).
- **URL única por vídeo:** um identificador público de 11 caracteres, sem conflito com outros vídeos.
- **Streaming e download:** o storage serve os bytes (com suporte a `Range`/`206`), sem que o arquivo precise ser baixado por inteiro para começar a assistir.
- **Ciclo de status visível no banco:** `draft → processing → ready | failed`, com o motivo da falha registrado.

### Como o fluxo funciona

1. `POST /videos` — cria o rascunho e abre um *multipart upload* no storage. Devolve o id público, o tamanho de cada parte e a quantidade de partes.
2. `POST /videos/:videoId/upload/part-urls` — assina, sob demanda, as URLs de upload das partes que o cliente pedir. (`GET .../upload/parts` lista o que o storage já recebeu, para retomar um upload interrompido.)
3. O cliente envia cada parte **direto ao storage** e guarda o `ETag` de cada uma.
4. `POST /videos/:videoId/upload/complete` — fecha o multipart, confere o tamanho final, muda o vídeo para `processing` e coloca o job na fila. Repetir a chamada é seguro (idempotente).
5. O **Video Worker** consome a fila: ffprobe → metadados, ffmpeg → thumbnail, e então o vídeo vira `ready`. Mídia inválida vai para `failed` sem retentativas; falhas transitórias são reexecutadas com espera crescente.
6. `GET /videos/:videoId` acompanha o status; `GET .../stream` e `GET .../download` (só para vídeos `ready`) devolvem URLs temporárias do storage.

Para upload interrompido: `POST .../upload/restart` reabre o envio no mesmo id; `DELETE /videos/:videoId` remove um vídeo `draft` ou `failed` junto com seus objetos.

O contrato HTTP completo está em [`nestjs-project/openapi.json`](nestjs-project/openapi.json).

---

## Arquitetura

O diagrama completo está em [`docs/diagrams/software-arch.mermaid`](docs/diagrams/software-arch.mermaid). Em resumo, a Fase 03 adicionou três peças à arquitetura que já existia:

- **Object Storage (MinIO/S3):** guarda os vídeos e as thumbnails. Em desenvolvimento é um MinIO no Docker; em produção, troca-se por S3 sem mudar o código, porque falamos a API do S3.
- **Fila (BullMQ sobre Redis):** leva os pedidos de processamento da API até o worker.
- **Video Worker:** um processo separado (serviço `video-worker` no Compose) que roda o ffprobe/ffmpeg. Assim, o processamento pesado nunca compete com as requisições da API.

Tudo sobe com `docker compose up -d`, junto com o backend, e os hosts entre serviços são sempre o **nome do serviço do Compose** (nunca `localhost`).

Onde as coisas moram em `nestjs-project/src/`:

- `videos/` — módulo de vídeos: controller, serviços de upload e de leitura, entidade, DTOs, exceções de domínio e a parte de processamento (produtor e consumidor da fila).
- `storage/` — o único código que fala com o S3/MinIO.
- `queue/` — a conexão BullMQ com o Redis.
- `media/` — wrappers do ffprobe/ffmpeg, independentes de fila e banco.
- `worker/` e `worker.ts` — o processo do worker (sem HTTP).

---

## Decisões técnicas e por quê

As 15 decisões da fase estão documentadas, com opções, prós e contras, em [`docs/decisions/technical-decisions-phase-03-videos.md`](docs/decisions/technical-decisions-phase-03-videos.md). As principais, em linguagem direta:

### Por que BullMQ (e Redis) para a fila?
A fila era o único ponto em aberto da arquitetura ("TBD"). Comparamos três caminhos:

- **BullMQ + Redis (escolhido):** retentativas com espera crescente, deduplicação por job, recuperação de jobs travados e "falhar de vez" para mídia inválida já vêm como opções do job. Tem integração oficial com o NestJS. O custo é um serviço a mais (um Redis pequeno).
- **RabbitMQ:** é um broker de verdade e muito flexível, mas é o mais pesado, e retry/backoff/dedup teríamos de montar à mão com filas de *dead-letter*. Para um único tipo de job, seria complexidade demais.
- **pg-boss (fila no próprio PostgreSQL):** não exige infraestrutura nova e permite enfileirar na mesma transação do banco, mas não tem módulo oficial para NestJS e a fila disputaria o banco com a aplicação.

O ponto fraco do BullMQ é que o job fica no Redis, fora da transação do Postgres. Resolvemos isso tornando o `complete` **idempotente**: o `jobId` é o id do vídeo, então repetir a chamada nunca duplica o job nem o perde. Também exigimos `maxmemory-policy noeviction` no Redis, para que jobs nunca sejam descartados em silêncio.

### Por que o upload vai direto ao storage (multipart)?
Passar 10 GB pela API prenderia memória, banda e conexões, exatamente o que a fase queria evitar. Avaliamos:

- **Multipart S3 com URLs pré-assinadas (escolhido):** nenhum byte do arquivo passa pela API; permite partes em paralelo e **retomar** um upload que caiu, reenviando só as partes que faltam. A parte tem tamanho fixo (100 MiB por padrão), o que dá cerca de 100 partes para 10 GB, bem abaixo do limite de 10.000 do S3.
- **Protocolo tus pela API:** simples para o cliente, mas os 10 GB atravessariam a API.
- **Um único `PUT` pré-assinado:** o mais simples, mas o S3 limita a 5 GB por requisição e não há como retomar.

### Por que o worker vive no mesmo código, mas em outro processo?
Precisamos de isolamento de CPU e processo, mas não de um segundo projeto. O worker é o mesmo código do `nestjs-project/`, com outro ponto de entrada (`src/worker.ts`) e outro serviço no Compose. Assim ele reaproveita as entidades, a configuração e a mesma esteira de testes.

### Como o FFmpeg lê um vídeo de 10 GB?
O worker **não copia o arquivo para o disco**. Ele assina uma URL de leitura temporária (no endpoint interno do storage) e entrega essa URL ao ffprobe/ffmpeg, que lê só os trechos de que precisa por requisições `Range`. Processar um vídeo de 10 GB custa quase o mesmo que um de 100 MB e não exige disco grande no worker. O ffmpeg vem do pacote do sistema, chamado por um pequeno wrapper com `spawn`. A thumbnail é o frame em 10% da duração (com o frame 0 como alternativa), em JPEG de no máximo 1280 px.

### Como garantimos a URL única?
O identificador público tem 11 caracteres em base64url, gerados com `node:crypto`, e a coluna é `UNIQUE` no banco. Se houver colisão (raríssima), o serviço sorteia outro. O banco é a garantia final de que dois vídeos nunca compartilham o mesmo id. O id interno (UUID) nunca é exposto ao cliente.

### Como o streaming e o download funcionam?
A API só **autoriza** e devolve uma URL temporária (`{ url, expires_at }`); o próprio storage entrega os bytes, com `Range`/`206` nativos. O download usa o mesmo mecanismo, forçando `Content-Disposition: attachment`. Alternativas descartadas: fazer a API ser proxy (todo byte de toda visualização passaria por ela) e HLS/DASH (exigiria transcodificação pesada, além do que a fase pede).

### Por que um bucket privado e acesso só pelo dono?
Há um único bucket privado, com um prefixo por vídeo (`videos/{id}/`), e todo acesso é por URL pré-assinada. Até a Fase 04 (publicação), só o dono enxerga seus vídeos; qualquer outro usuário recebe `404`. Isso mantém um único caminho de controle de acesso, que a Fase 04 só precisa estender.

### Como o status e as falhas são tratados?
O ciclo é `draft → processing → ready | failed`, com `failure_reason` explicando o porquê:

- Mídia inválida (`INVALID_MEDIA`) falha de imediato, sem retentativas, porque tentar de novo não resolveria.
- Erros transitórios são reexecutados com espera crescente; esgotadas as tentativas, o vídeo termina em `PROCESSING_FAILED`.
- Um upload cujo multipart expirou vira `failed`/`UPLOAD_EXPIRED`, e o dono pode **reiniciar** (mesmo id) ou **excluir**.
- Arquivos acima do limite de 10 GB viram `failed`/`FILE_TOO_LARGE` e têm seus objetos removidos.

### ⚠️ Por que `bitnamilegacy/minio` e não o `minio/minio` oficial?

> [!WARNING]
> ⚠️ **O MinIO deixou de publicar imagens e binários da edição Community em outubro de 2025** e o repositório entrou em modo de manutenção (depois, arquivado). Na prática, as imagens oficiais **não podem mais ser baixadas de forma anônima**. Por isso o Compose deste projeto usa `bitnamilegacy/minio`, uma imagem **congelada** que **não recebe mais correções de segurança**.
>
> 🚫 **Use essa imagem apenas em desenvolvimento e testes.** Em produção, use AWS S3 (ou um MinIO mantido por quem o distribui hoje).

O que aconteceu, em ordem:

- A spec e a arquitetura do projeto apontam para "S3 ou MinIO", e o MinIO local era o caminho natural. Durante o research (TD-10), comparamos três opções: fixar a última imagem Community do MinIO, trocar por SeaweedFS ou trocar por Garage. Ficamos com o MinIO por ser o servidor S3 de referência: é o mais fiel em multipart, URLs pré-assinadas e CORS, justamente o que o upload de 10 GB usa. Como produção será S3, o risco de uma imagem congelada ficava restrito ao ambiente local.
- Na hora de implementar, o plano esbarrou na realidade: tanto `minio/minio` (Docker Hub) quanto `quay.io/minio/minio` **recusam o pull anônimo**, mesmo com tags de versão datadas. Verificamos com `docker pull`: o Docker Hub respondeu "repository does not exist" e o Quay respondeu `401 UNAUTHORIZED`.
- A alternativa foi a build arquivada da Bitnami, que ainda é MinIO de verdade (a versão `RELEASE 2025-07-23`). Fixamos a imagem por **tag e digest** (`bitnamilegacy/minio:2025.7.23-debian-12-r5@sha256:…`), nunca por `latest`, para o ambiente ser reproduzível.

O que isso significa na prática:

- 🔒 **Segurança:** a imagem não recebe correções. A CVE-2025-62506 continua aberta nela, mas afeta o caminho de STS, que o projeto não usa.
- 🔀 **Diferenças em relação ao S3 real:** o MinIO não implementa `PutBucketCors` (o CORS já vem ligado) nem a regra de ciclo de vida `AbortIncompleteMultipartUpload`. Em produção com S3, as duas precisam ser configuradas; os detalhes estão no `nestjs-project/CLAUDE.md`.
- ✅ **Sem mudança de código para migrar:** como falamos a API do S3 pelo SDK da AWS, trocar o MinIO por S3 (ou por outro servidor compatível) é questão de configuração (`S3_ENDPOINT`, credenciais e bucket).
- A decisão e sua revisão estão registradas em [`docs/decisions/technical-decisions-phase-03-videos.md`](docs/decisions/technical-decisions-phase-03-videos.md) (TD-10).

### Por que testar com MinIO e Redis de verdade?
O contrato de multipart, URLs pré-assinadas e `Range` só é exercitado de verdade contra um S3 real. Por isso os testes de integração e e2e rodam contra o MinIO e o Redis do Compose, com bucket (`streamtube-videos-test`) e prefixo de fila (`bull-test`) próprios, que nunca tocam os do ambiente de desenvolvimento.

---

## Critérios de aceite

### Decisões e planejamento
- [x] **Decisões técnicas** das questões em aberto (fila, upload, streaming, processamento/thumbnail, ciclo de status), justificadas — [`technical-decisions-phase-03-videos.md`](docs/decisions/technical-decisions-phase-03-videos.md)
- [x] **Pasta da fase completa** em [`docs/phases/phase-03-videos/`](docs/phases/phase-03-videos/): `context.md`, `validation.md` (**status `clean`**), `library-refs.md`, o plano `phase-03-videos.md` e o `progress.md`
- [x] **Plano no formato do projeto:** SI-03.1 a SI-03.13, Data Model, API Contracts, Authorization Matrix, Error Catalog, Events/Messages, Dependency Map e Deliverables

### Implementação — feature
- [x] **Upload de até 10 GB sem travar a API**, com pré-cadastro como rascunho ao iniciar
- [x] **Processamento automático:** duração, metadados e thumbnail
- [x] **URL única** por vídeo, sem conflito
- [x] **Streaming** (sem baixar tudo) e **download**
- [x] **Ciclo de status** refletido no banco

### Implementação — infraestrutura e qualidade
- [x] **Storage, fila e worker no Compose**, subindo junto com o backend
- [x] **Migration** `CreateVideos` e entidade ligada ao canal
- [x] **Testes nos três níveis**, passando: unitários, integração (banco, MinIO, Redis e ffmpeg reais) e e2e
- [x] **Definition of Done:** suíte completa verde, `npx tsc --noEmit` com código 0 e lint sem erros
- [x] **Git Flow:** trabalho em `feature/phase-03-videos` a partir de `dev`; nenhum commit direto em `main`

### Documentação
- [x] **`CLAUDE.md` atualizado** (raiz e `nestjs-project/`) com a seção de vídeos, conferido contra o código

### Resultado da última verificação
- Suíte unitária e de integração: **447 testes, 44 suítes, todos passando**, e o Jest encerra sozinho
- E2E: **81 testes, 8 suítes, todos passando**
- `npx tsc --noEmit`: código **0**
- Lint: **0 erros** (restam 22 avisos de tipagem em specs, que não bloqueiam)

---

## Como rodar

Todos os comandos rodam **dentro do container**, a partir de `nestjs-project/`:

```bash
cp .env.example .env          # veja a observação abaixo sobre MAIL_FROM
docker compose up -d          # API, Postgres, Mailpit, Redis, MinIO e video-worker

docker compose exec nestjs-api npm run migration:run
docker compose exec nestjs-api npm test -- --runInBand
docker compose exec nestjs-api npm run test:e2e
docker compose exec nestjs-api npx tsc --noEmit
docker compose exec nestjs-api npm run lint
```

- **`MAIL_FROM`:** o valor do `.env.example` contém `<` e `>`, que quebram o parser do Compose. Ao copiar o arquivo, coloque o valor entre aspas simples por fora, como em `MAIL_FROM='"StreamTube" <noreply@streamtube.com>'`.
- **Testes em série:** a suíte usa um banco de testes compartilhado, por isso roda com `--runInBand`.
- **Abrir uma URL pré-assinada no navegador do host:** como o host é o nome do serviço, mapeie `127.0.0.1 minio` no arquivo hosts. Os testes não precisam disso.
- **Worker:** `docker compose logs video-worker` deve mostrar `Video worker started`. Antes de rodar `npm run build`, pare o worker (`docker compose stop video-worker`), porque o build esvazia o `dist/` que o worker observa.

Mais detalhes operacionais (variáveis, MinIO × S3 de produção, CORS, uploads incompletos) estão em [`nestjs-project/CLAUDE.md`](nestjs-project/CLAUDE.md), na seção "Videos: storage, queue and worker".

---

## Limitações conhecidas

- **Nenhum upload real de 10 GB foi executado.** O limite e a divisão em partes são verificados por aritmética e por testes de multipart com partes reais no MinIO; a arquitetura (bytes direto ao storage) é o que sustenta o tamanho.
- **Vídeos sem duração legível são rejeitados** como mídia inválida (por exemplo, algumas gravações de navegador em webm).
- ⚠️ **O MinIO usado é uma imagem congelada** (`bitnamilegacy/minio`), só para desenvolvimento e testes; veja o aviso na seção de decisões. Em produção com S3, é preciso configurar uma regra de CORS que exponha o `ETag` e uma regra de ciclo de vida para uploads incompletos.
- **A jornada completa (API → fila → worker → `ready`) não tem um único teste automatizado.** Os e2e simulam a conclusão do worker; o worker real é coberto nos testes de integração.

---

## O processo com IA

A fase foi conduzida pelo workflow do projeto, e cada etapa deixou um artefato rastreável no repositório:

| Etapa | Artefato |
|---|---|
| Pesquisa e decisões (`research`) | [`docs/decisions/technical-decisions-phase-03-videos.md`](docs/decisions/technical-decisions-phase-03-videos.md) |
| Contexto (`plan-context`) | [`context.md`](docs/phases/phase-03-videos/context.md) |
| Validação (`plan-validate`) | [`validation.md`](docs/phases/phase-03-videos/validation.md) |
| Resolução e libs (`plan-resolve`) | [`library-refs.md`](docs/phases/phase-03-videos/library-refs.md) |
| Plano executável (`plan-build`) | [`phase-03-videos.md`](docs/phases/phase-03-videos/phase-03-videos.md) |
| Implementação SI a SI (`implement`) | código + [`progress.md`](docs/phases/phase-03-videos/progress.md) |

O `progress.md` registra, por SI, os testes executados e as decisões tomadas além do plano. Antes de usar cada biblioteca, a documentação foi consultada via context7 na versão instalada.
