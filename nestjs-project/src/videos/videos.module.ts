import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ChannelsModule } from '../channels/channels.module';
import { StorageModule } from '../storage/storage.module';
import { Video } from './entities/video.entity';
import { VideoProcessingQueueModule } from './processing/video-processing-queue.module';
import { VideoResponseMapper } from './video-response.mapper';
import { VideoUploadsService } from './video-uploads.service';
import { VideosController } from './videos.controller';
import { VideosService } from './videos.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([Video]),
    StorageModule,
    ChannelsModule,
    VideoProcessingQueueModule,
  ],
  controllers: [VideosController],
  providers: [VideosService, VideoUploadsService, VideoResponseMapper],
})
export class VideosModule {}
