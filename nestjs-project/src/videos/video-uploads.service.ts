import { randomUUID } from 'crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ChannelsService } from '../channels/channels.service';
import videosConfig from '../config/videos.config';
import { StorageService } from '../storage/storage.service';
import type { CompleteVideoUploadDto } from './dto/complete-video-upload.dto';
import type { InitiateVideoUploadDto } from './dto/initiate-video-upload.dto';
import type { RestartVideoUploadDto } from './dto/restart-video-upload.dto';
import type { SignUploadPartsDto } from './dto/sign-upload-parts.dto';
import type { SignedUploadPartsResponseDto } from './dto/signed-upload-parts-response.dto';
import type { UploadedPartsResponseDto } from './dto/uploaded-parts-response.dto';
import type { VideoResponseDto } from './dto/video-response.dto';
import type { VideoUploadResponseDto } from './dto/video-upload-response.dto';
import { VideoStatus } from './entities/video-status.enum';
import { Video } from './entities/video.entity';
import {
  StorageInvalidPartsError,
  StorageUploadNotFoundError,
} from '../storage/storage.errors';
import type { StorageUploadedPart } from '../storage/storage.types';
import {
  InvalidPartNumberException,
  InvalidUploadPartsException,
  InvalidUploadStateException,
  UnsupportedVideoTypeException,
  UploadExpiredException,
  VideoTooLargeException,
} from './exceptions/video.exceptions';
import { isUniqueViolationOnColumn } from './pg-unique-violation.util';
import { generatePublicId } from './public-id.util';
import { VideoProcessingQueue } from './processing/video-processing.queue';
import { originalKey, videoPrefix } from './video-storage-keys';
import { deriveTitleFromFilename } from './video-title.util';
import { VideoResponseMapper } from './video-response.mapper';
import { VideosService } from './videos.service';
import {
  MAX_PUBLIC_ID_ATTEMPTS,
  VideoFailureReason,
  isAllowedVideoMimeType,
} from './videos.constants';

interface DraftParams {
  id: string;
  channelId: string;
  title: string;
  dto: InitiateVideoUploadDto;
  storageKey: string;
  uploadId: string;
  partSizeBytes: number;
  partCount: number;
}

@Injectable()
export class VideoUploadsService {
  private readonly logger = new Logger(VideoUploadsService.name);

  constructor(
    @InjectRepository(Video)
    private readonly videoRepository: Repository<Video>,
    private readonly channelsService: ChannelsService,
    private readonly videosService: VideosService,
    private readonly storage: StorageService,
    private readonly responseMapper: VideoResponseMapper,
    private readonly processingQueue: VideoProcessingQueue,
    @Inject(videosConfig.KEY)
    private readonly config: ConfigType<typeof videosConfig>,
  ) {}

  async initiate(
    userId: string,
    dto: InitiateVideoUploadDto,
  ): Promise<VideoUploadResponseDto> {
    if (!isAllowedVideoMimeType(dto.mime_type)) {
      throw new UnsupportedVideoTypeException();
    }
    if (dto.size_bytes > this.config.maxSizeBytes) {
      throw new VideoTooLargeException();
    }

    const channel = await this.channelsService.findByUserId(userId);
    if (!channel) {
      // Registration always creates the channel, so this is a broken
      // invariant (HTTP 500), not a client error.
      throw new Error(`No channel found for user ${userId}`);
    }

    const id = randomUUID();
    const storageKey = originalKey(id);
    const { partSizeBytes, partCount } = this.uploadGeometry(dto.size_bytes);

    const uploadId = await this.storage.createMultipartUpload(
      storageKey,
      dto.mime_type,
    );

    let video: Video;
    try {
      video = await this.saveDraft({
        id,
        channelId: channel.id,
        title: dto.title ?? deriveTitleFromFilename(dto.filename),
        dto,
        storageKey,
        uploadId,
        partSizeBytes,
        partCount,
      });
    } catch (error) {
      await this.abortOrphanedUpload(storageKey, uploadId);
      throw error;
    }

    return {
      video: await this.responseMapper.toVideoResponse(video),
      upload: { part_size_bytes: partSizeBytes, part_count: partCount },
    };
  }

  // Reopens an expired upload on the same video (same public id, same
  // storage key): only a video that failed as UPLOAD_EXPIRED qualifies.
  async restart(
    userId: string,
    publicId: string,
    dto: RestartVideoUploadDto,
  ): Promise<VideoUploadResponseDto> {
    const video = await this.videosService.findOwnedByPublicId(
      userId,
      publicId,
    );
    if (
      video.status !== VideoStatus.FAILED ||
      video.failure_reason !== VideoFailureReason.UPLOAD_EXPIRED
    ) {
      throw new InvalidUploadStateException();
    }
    const sizeBytes = dto.size_bytes ?? Number(video.size_bytes);
    if (sizeBytes > this.config.maxSizeBytes) {
      throw new VideoTooLargeException();
    }

    const { partSizeBytes, partCount } = this.uploadGeometry(sizeBytes);
    const uploadId = await this.storage.createMultipartUpload(
      video.storage_key,
      video.mime_type,
    );

    try {
      // Conditional on the state read above: a concurrent restart must not
      // leave two open multipart uploads, only one of them recorded.
      const result = await this.videoRepository.update(
        {
          id: video.id,
          status: VideoStatus.FAILED,
          failure_reason: VideoFailureReason.UPLOAD_EXPIRED,
        },
        {
          status: VideoStatus.DRAFT,
          failure_reason: null,
          upload_id: uploadId,
          size_bytes: String(sizeBytes),
          part_size_bytes: partSizeBytes,
          part_count: partCount,
        },
      );
      if (!result.affected) {
        throw new InvalidUploadStateException();
      }
    } catch (error) {
      await this.abortOrphanedUpload(video.storage_key, uploadId);
      throw error;
    }

    return {
      video: await this.responseMapper.toVideoResponse(
        await this.videoRepository.findOneByOrFail({ id: video.id }),
      ),
      upload: { part_size_bytes: partSizeBytes, part_count: partCount },
    };
  }

  // Signing is a local computation, so the storage is probed first (ListParts):
  // an expired upload is reported now instead of after the client has sent
  // hundreds of MiB to a dead multipart upload.
  async signParts(
    userId: string,
    publicId: string,
    dto: SignUploadPartsDto,
  ): Promise<SignedUploadPartsResponseDto> {
    const video = await this.findDraftWithOpenUpload(userId, publicId);
    if (dto.part_numbers.some((part) => part > video.part_count)) {
      throw new InvalidPartNumberException();
    }
    await this.listPartsOrExpire(video);

    const ttl = this.config.uploadUrlTtlSeconds;
    const parts = await Promise.all(
      dto.part_numbers.map(async (partNumber) => ({
        part_number: partNumber,
        url: await this.storage.presignUploadPart(
          video.storage_key,
          video.upload_id as string,
          partNumber,
          ttl,
        ),
      })),
    );
    return {
      parts,
      expires_at: new Date(Date.now() + ttl * 1000).toISOString(),
    };
  }

  async listUploadedParts(
    userId: string,
    publicId: string,
  ): Promise<UploadedPartsResponseDto> {
    const video = await this.findDraftWithOpenUpload(userId, publicId);
    const uploaded = await this.listPartsOrExpire(video);

    return {
      part_size_bytes: video.part_size_bytes,
      part_count: video.part_count,
      uploaded_parts: uploaded.map((part) => ({
        part_number: part.partNumber,
        etag: part.etag,
        size_bytes: part.sizeBytes,
      })),
    };
  }

  // Idempotent: a repeated call on a processing video only re-enqueues it
  // (the jobId dedups), which also recovers an enqueue that failed on the
  // first call after the status was already saved.
  async complete(
    userId: string,
    publicId: string,
    dto: CompleteVideoUploadDto,
  ): Promise<VideoResponseDto> {
    const video = await this.videosService.findOwnedByPublicId(
      userId,
      publicId,
    );
    return this.completeFrom(video, dto);
  }

  private async completeFrom(
    video: Video,
    dto: CompleteVideoUploadDto,
  ): Promise<VideoResponseDto> {
    switch (video.status) {
      case VideoStatus.DRAFT:
        return this.completeDraft(video, dto);
      case VideoStatus.PROCESSING:
        await this.processingQueue.enqueue(video.id);
        return this.responseMapper.toVideoResponse(video);
      case VideoStatus.READY:
        return this.responseMapper.toVideoResponse(video);
      default:
        throw new InvalidUploadStateException();
    }
  }

  private async completeDraft(
    video: Video,
    dto: CompleteVideoUploadDto,
  ): Promise<VideoResponseDto> {
    if (!video.upload_id) {
      throw new InvalidUploadStateException();
    }
    await this.assembleOrFail(video, dto);

    // The limit is checked on the assembled object: the declared size_bytes
    // comes from the client and cannot be trusted.
    const { contentLength } = await this.storage.headObject(video.storage_key);
    if (contentLength > this.config.maxSizeBytes) {
      await this.storage.deletePrefix(videoPrefix(video.id));
      await this.videoRepository.update(
        { id: video.id },
        {
          status: VideoStatus.FAILED,
          failure_reason: VideoFailureReason.FILE_TOO_LARGE,
          upload_id: null,
        },
      );
      throw new VideoTooLargeException();
    }

    await this.videoRepository.update(
      { id: video.id },
      {
        size_bytes: String(contentLength),
        upload_id: null,
        status: VideoStatus.PROCESSING,
      },
    );
    await this.processingQueue.enqueue(video.id);
    return this.responseMapper.toVideoResponse(
      await this.videoRepository.findOneByOrFail({ id: video.id }),
    );
  }

  private async assembleOrFail(
    video: Video,
    dto: CompleteVideoUploadDto,
  ): Promise<void> {
    try {
      await this.storage.completeMultipartUpload(
        video.storage_key,
        video.upload_id as string,
        dto.parts.map((part) => ({
          partNumber: part.part_number,
          etag: part.etag,
        })),
      );
    } catch (error) {
      if (error instanceof StorageInvalidPartsError) {
        throw new InvalidUploadPartsException();
      }
      if (error instanceof StorageUploadNotFoundError) {
        await this.failExpiredUpload(video);
      }
      throw error;
    }
  }

  private uploadGeometry(sizeBytes: number): {
    partSizeBytes: number;
    partCount: number;
  } {
    const partSizeBytes = this.config.uploadPartSizeBytes;
    return { partSizeBytes, partCount: Math.ceil(sizeBytes / partSizeBytes) };
  }

  private async findDraftWithOpenUpload(
    userId: string,
    publicId: string,
  ): Promise<Video> {
    const video = await this.videosService.findOwnedByPublicId(
      userId,
      publicId,
    );
    if (video.status !== VideoStatus.DRAFT || !video.upload_id) {
      throw new InvalidUploadStateException();
    }
    return video;
  }

  // NoSuchUpload means the multipart upload is gone (aborted or reclaimed by
  // the storage): the draft can no longer receive parts. Any other storage
  // error is not an expiry and propagates untouched.
  private async listPartsOrExpire(
    video: Video,
  ): Promise<StorageUploadedPart[]> {
    try {
      return await this.storage.listParts(
        video.storage_key,
        video.upload_id as string,
      );
    } catch (error) {
      if (error instanceof StorageUploadNotFoundError) {
        await this.failExpiredUpload(video);
      }
      throw error;
    }
  }

  // Conditional on draft: a concurrent complete may have already moved the
  // video on, and its state must not be overwritten by this late NoSuchUpload.
  private async failExpiredUpload(video: Video): Promise<never> {
    await this.videoRepository.update(
      { id: video.id, status: VideoStatus.DRAFT },
      {
        status: VideoStatus.FAILED,
        failure_reason: VideoFailureReason.UPLOAD_EXPIRED,
        upload_id: null,
      },
    );
    throw new UploadExpiredException();
  }

  // A public_id collision (64-bit random, so astronomically rare) only
  // re-rolls the id: each attempt is its own statement, not a transaction.
  private async saveDraft(params: DraftParams): Promise<Video> {
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.videoRepository.save(
          this.videoRepository.create({
            id: params.id,
            public_id: generatePublicId(),
            channel_id: params.channelId,
            title: params.title,
            original_filename: params.dto.filename,
            mime_type: params.dto.mime_type,
            size_bytes: String(params.dto.size_bytes),
            storage_key: params.storageKey,
            upload_id: params.uploadId,
            part_size_bytes: params.partSizeBytes,
            part_count: params.partCount,
          }),
        );
      } catch (error) {
        const isRetryable = isUniqueViolationOnColumn(error, 'public_id');
        if (!isRetryable || attempt >= MAX_PUBLIC_ID_ATTEMPTS) throw error;
      }
    }
  }

  // Compensation only: the caller rethrows the original persistence error, so
  // a failed abort is logged and must not mask it.
  private async abortOrphanedUpload(
    storageKey: string,
    uploadId: string,
  ): Promise<void> {
    try {
      await this.storage.abortMultipartUpload(storageKey, uploadId);
    } catch (abortError) {
      this.logger.warn(
        `Could not abort orphaned multipart upload for ${storageKey}: ${String(abortError)}`,
      );
    }
  }
}
