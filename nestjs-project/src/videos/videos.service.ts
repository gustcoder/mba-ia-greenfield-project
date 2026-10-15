import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Video } from './entities/video.entity';
import { VideoNotFoundException } from './exceptions/video.exceptions';
import { isPublicIdFormat } from './public-id.util';

@Injectable()
export class VideosService {
  constructor(
    @InjectRepository(Video)
    private readonly videoRepository: Repository<Video>,
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
}
