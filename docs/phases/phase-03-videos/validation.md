---
kind: phase
name: phase-03-videos
status: clean
issue_count: 0
sources_mtime:
  docs/phases/phase-03-videos/context.md: "2026-10-14T19:05:27-03:00"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-10-14T19:04:00-03:00"
issues:
  - id: AMB-1
    status: resolved
    summary: "Which video metadata is extracted/persisted beyond duration, and in what shape"
    resolved_by: phase-03-videos/TD-03
  - id: AMB-2
    status: resolved
    summary: "Thumbnail frame selection rule, output format/size, short-video edge case"
    resolved_by: phase-03-videos/TD-03
  - id: AMB-3
    status: resolved
    summary: "Accepted upload formats (MIME/container allowlist) and where they are enforced"
    resolved_by: phase-03-videos/TD-05
  - id: AMB-4
    status: resolved
    summary: "Initial title of the pre-registered draft (Phase 03 vs Phase 04 editing boundary)"
    resolved_by: phase-03-videos/TD-07
  - id: AMB-5
    status: resolved
    summary: "Whether Phase 03 exposes an owner read endpoint for video detail/status"
    resolved_by: phase-03-videos/TD-12
  - id: AMB-6
    status: resolved
    summary: "Fate of abandoned drafts whose upload is never completed"
    resolved_by: phase-03-videos/TD-13
  - id: OQ-1
    status: resolved
    summary: "TD-01 pending — Queue technology"
    resolved_by: phase-03-videos/TD-01
  - id: OQ-2
    status: resolved
    summary: "TD-02 pending — Video worker runtime topology"
    resolved_by: phase-03-videos/TD-02
  - id: OQ-3
    status: resolved
    summary: "TD-03 pending — FFmpeg/ffprobe invocation strategy"
    resolved_by: phase-03-videos/TD-03
  - id: OQ-4
    status: resolved
    summary: "TD-04 pending — How the worker reads the source video"
    resolved_by: phase-03-videos/TD-04
  - id: OQ-5
    status: resolved
    summary: "TD-05 pending — Upload protocol for files up to 10GB"
    resolved_by: phase-03-videos/TD-05
  - id: OQ-6
    status: resolved
    summary: "TD-06 pending — Multipart part sizing & part-URL signing cadence"
    resolved_by: phase-03-videos/TD-06
  - id: OQ-7
    status: resolved
    summary: "TD-07 pending — Draft pre-registration & upload-completion trigger"
    resolved_by: phase-03-videos/TD-07
  - id: OQ-8
    status: resolved
    summary: "TD-08 pending — Unique video URL identifier"
    resolved_by: phase-03-videos/TD-08
  - id: OQ-9
    status: resolved
    summary: "TD-09 pending — Object storage layout, privacy & endpoints"
    resolved_by: phase-03-videos/TD-09
  - id: OQ-10
    status: resolved
    summary: "TD-10 pending — Local S3-compatible server image"
    resolved_by: phase-03-videos/TD-10
  - id: OQ-11
    status: resolved
    summary: "TD-11 pending — Byte delivery for streaming and download"
    resolved_by: phase-03-videos/TD-11
  - id: OQ-12
    status: resolved
    summary: "TD-12 pending — Stream/download access before publication exists"
    resolved_by: phase-03-videos/TD-12
  - id: OQ-13
    status: resolved
    summary: "TD-13 pending — Video status lifecycle model"
    resolved_by: phase-03-videos/TD-13
  - id: OQ-14
    status: resolved
    summary: "TD-14 pending — Processing failure & retry policy"
    resolved_by: phase-03-videos/TD-14
  - id: OQ-15
    status: resolved
    summary: "TD-15 pending — Test strategy for object storage and queue"
    resolved_by: phase-03-videos/TD-15
advisories: []
---

# phase-03-videos — Validation

## Findings

### Inconsistencies

_None._

### Ambiguities

_None._

### Missing Decisions

_None._

### Dependency Gaps

_None._

### Inherited Constraint Conflicts

_None._

### Unresolved Open Questions

_None._

### UI Coverage Gaps

_None._ _(UI not in scope for this phase — `## UI Inventory` absent.)_

## Resolved Issues

- **AMB-1** _(resolved_by phase-03-videos/TD-03)_ — Which video metadata is extracted/persisted beyond duration, and in what shape. Clarified as TD-03 revision: typed columns (`duration_seconds`, `width`, `height`, `video_codec`, `size_bytes`) + JSONB `metadata` with summarized ffprobe output.
- **AMB-2** _(resolved_by phase-03-videos/TD-03)_ — Thumbnail frame selection rule, output format/size, short-video edge case. Clarified as TD-03 revision: frame at 10% of duration, JPEG max 1280px width, fallback to frame 0.
- **AMB-3** _(resolved_by phase-03-videos/TD-05)_ — Accepted upload formats (MIME/container allowlist) and where they are enforced. Clarified as TD-05 revision: MIME allowlist at initiation (mp4, quicktime, webm, x-matroska → else 400) + ffprobe fail-fast in the worker (TD-14).
- **AMB-4** _(resolved_by phase-03-videos/TD-07)_ — Initial title of the pre-registered draft (Phase 03 vs Phase 04 editing boundary). Clarified as TD-07 revision: optional `title` on initiation, default = filename without extension; description/category stay in Phase 04.
- **AMB-5** _(resolved_by phase-03-videos/TD-12)_ — Whether Phase 03 exposes an owner read endpoint for video detail/status. Clarified as TD-12 revision: owner-only `GET` for a single video in Phase 03; listings stay in Phase 04.
- **AMB-6** _(resolved_by phase-03-videos/TD-13)_ — Fate of abandoned drafts whose upload is never completed. Clarified as TD-13 revision: resume via `ListParts` while multipart exists; lazy `NoSuchUpload` → `failed` (`UPLOAD_EXPIRED`); owner may restart (same video/public ID) or delete; no scheduler.
- **OQ-1** _(resolved_by phase-03-videos/TD-01)_ — TD-01 pending — Queue technology. Decision: A (BullMQ + Redis).
- **OQ-2** _(resolved_by phase-03-videos/TD-02)_ — TD-02 pending — Video worker runtime topology. Decision: A (same codebase, separate entrypoint/container).
- **OQ-3** _(resolved_by phase-03-videos/TD-03)_ — TD-03 pending — FFmpeg/ffprobe invocation strategy. Decision: A (apt binaries + spawn wrapper).
- **OQ-4** _(resolved_by phase-03-videos/TD-04)_ — TD-04 pending — How the worker reads the source video. Decision: B (presigned URL as FFmpeg input).
- **OQ-5** _(resolved_by phase-03-videos/TD-05)_ — TD-05 pending — Upload protocol for files up to 10GB. Decision: A (S3 multipart, presigned parts).
- **OQ-6** _(resolved_by phase-03-videos/TD-06)_ — TD-06 pending — Multipart part sizing & part-URL signing cadence. Decision: B (fixed part size, on-demand signing, ListParts).
- **OQ-7** _(resolved_by phase-03-videos/TD-07)_ — TD-07 pending — Draft pre-registration & upload-completion trigger. Decision: A (idempotent complete, jobId = videoId).
- **OQ-8** _(resolved_by phase-03-videos/TD-08)_ — TD-08 pending — Unique video URL identifier. Decision: A (11-char base64url + UNIQUE + retry).
- **OQ-9** _(resolved_by phase-03-videos/TD-09)_ — TD-09 pending — Object storage layout, privacy & endpoints. Decision: A (single private bucket, internal/public endpoints).
- **OQ-10** _(resolved_by phase-03-videos/TD-10)_ — TD-10 pending — Local S3-compatible server image. Decision: A (MinIO; image source revised to `bitnamilegacy/minio:2025.7.23-debian-12-r5`).
- **OQ-11** _(resolved_by phase-03-videos/TD-11)_ — TD-11 pending — Byte delivery for streaming and download. Decision: A (presigned GET, attachment for download).
- **OQ-12** _(resolved_by phase-03-videos/TD-12)_ — TD-12 pending — Stream/download access before publication exists. Decision: A (owner-only until Phase 04).
- **OQ-13** _(resolved_by phase-03-videos/TD-13)_ — TD-13 pending — Video status lifecycle model. Decision: B (processing enum; publication in Phase 04).
- **OQ-14** _(resolved_by phase-03-videos/TD-14)_ — TD-14 pending — Processing failure & retry policy. Decision: A (retries + fail-fast + failed with reason).
- **OQ-15** _(resolved_by phase-03-videos/TD-15)_ — TD-15 pending — Test strategy for object storage and queue. Decision: A (real MinIO + Redis, test-scoped).
