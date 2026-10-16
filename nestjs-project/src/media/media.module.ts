import { Module } from '@nestjs/common';
import { FfmpegRunner } from './ffmpeg-runner';
import { MediaService } from './media.service';

@Module({
  providers: [FfmpegRunner, MediaService],
  exports: [MediaService],
})
export class MediaModule {}
