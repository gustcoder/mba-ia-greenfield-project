import { Inject, Injectable } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import videosConfig from '../config/videos.config';
import { StorageService } from '../storage/storage.service';
import type { VideoResponseDto } from './dto/video-response.dto';
import type { Video } from './entities/video.entity';

// Only the public shape leaves the API: no uuid, upload_id, storage_key or
// channel_id. size_bytes comes from pg as a string (bigint) and is converted.
@Injectable()
export class VideoResponseMapper {
  constructor(
    private readonly storage: StorageService,
    @Inject(videosConfig.KEY)
    private readonly config: ConfigType<typeof videosConfig>,
  ) {}

  async toVideoResponse(video: Video): Promise<VideoResponseDto> {
    const thumbnailUrl = video.thumbnail_key
      ? await this.storage.presignGet(
          video.thumbnail_key,
          this.config.playbackUrlTtlSeconds,
        )
      : null;

    return {
      id: video.public_id,
      title: video.title,
      status: video.status,
      failure_reason: video.failure_reason,
      original_filename: video.original_filename,
      mime_type: video.mime_type,
      size_bytes: Number(video.size_bytes),
      duration_seconds: video.duration_seconds,
      width: video.width,
      height: video.height,
      video_codec: video.video_codec,
      thumbnail_url: thumbnailUrl,
      created_at: video.created_at.toISOString(),
      updated_at: video.updated_at.toISOString(),
    };
  }
}
