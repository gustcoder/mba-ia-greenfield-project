import { Inject, Injectable } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import videosConfig from '../config/videos.config';
import { StorageService } from '../storage/storage.service';
import { StorageUploadNotFoundError } from '../storage/storage.errors';
import type { PresignedUrlResponseDto } from './dto/presigned-url-response.dto';
import type { VideoResponseDto } from './dto/video-response.dto';
import { VideoStatus } from './entities/video-status.enum';
import { Video } from './entities/video.entity';
import {
  InvalidUploadStateException,
  VideoNotFoundException,
  VideoNotReadyException,
} from './exceptions/video.exceptions';
import { isPublicIdFormat } from './public-id.util';
import { VideoResponseMapper } from './video-response.mapper';
import { videoPrefix } from './video-storage-keys';

@Injectable()
export class VideosService {
  constructor(
    @InjectRepository(Video)
    private readonly videoRepository: Repository<Video>,
    private readonly storage: StorageService,
    private readonly responseMapper: VideoResponseMapper,
    @Inject(videosConfig.KEY)
    private readonly config: ConfigType<typeof videosConfig>,
  ) {}

  // A malformed id, a missing video and a video of another channel are
  // indistinguishable to the caller: all answer VIDEO_NOT_FOUND (TD-12).
  async findOwnedByPublicId(userId: string, publicId: string): Promise<Video> {
    if (!isPublicIdFormat(publicId)) {
      throw new VideoNotFoundException();
    }
    const video = await this.videoRepository.findOne({
      where: { public_id: publicId, channel: { user_id: userId } },
    });
    if (!video) {
      throw new VideoNotFoundException();
    }
    return video;
  }

  async getOwned(userId: string, publicId: string): Promise<VideoResponseDto> {
    return this.responseMapper.toVideoResponse(
      await this.findOwnedByPublicId(userId, publicId),
    );
  }

  // Bytes never pass through the API: the storage serves the signed url
  // itself, including Range requests (206) for seeking.
  async getStreamUrl(
    userId: string,
    publicId: string,
  ): Promise<PresignedUrlResponseDto> {
    const video = await this.findReadyOwned(userId, publicId);
    return this.sign(video.storage_key);
  }

  async getDownloadUrl(
    userId: string,
    publicId: string,
  ): Promise<PresignedUrlResponseDto> {
    const video = await this.findReadyOwned(userId, publicId);
    return this.sign(video.storage_key, video.original_filename);
  }

  private async findReadyOwned(
    userId: string,
    publicId: string,
  ): Promise<Video> {
    const video = await this.findOwnedByPublicId(userId, publicId);
    if (video.status !== VideoStatus.READY) {
      throw new VideoNotReadyException();
    }
    return video;
  }

  private async sign(
    storageKey: string,
    attachmentFilename?: string,
  ): Promise<PresignedUrlResponseDto> {
    const ttl = this.config.playbackUrlTtlSeconds;
    const url = await this.storage.presignGet(storageKey, ttl, {
      attachmentFilename,
    });
    return { url, expires_at: new Date(Date.now() + ttl * 1000).toISOString() };
  }

  // Only videos that never reached processing can be deleted here; the
  // management of processing/ready videos belongs to Phase 04.
  async deleteOwned(userId: string, publicId: string): Promise<void> {
    const video = await this.findOwnedByPublicId(userId, publicId);
    if (
      video.status !== VideoStatus.DRAFT &&
      video.status !== VideoStatus.FAILED
    ) {
      throw new InvalidUploadStateException();
    }

    if (video.upload_id) {
      try {
        await this.storage.abortMultipartUpload(
          video.storage_key,
          video.upload_id,
        );
      } catch (error) {
        // An already gone multipart upload is the state we want.
        if (!(error instanceof StorageUploadNotFoundError)) throw error;
      }
    }
    await this.storage.deletePrefix(videoPrefix(video.id));
    await this.videoRepository.delete({ id: video.id });
  }
}
