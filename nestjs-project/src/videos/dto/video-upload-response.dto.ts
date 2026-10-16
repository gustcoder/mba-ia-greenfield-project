import { ApiProperty } from '@nestjs/swagger';
import { UploadSessionDto } from './upload-session.dto';
import { VideoResponseDto } from './video-response.dto';

export class VideoUploadResponseDto {
  @ApiProperty({ type: VideoResponseDto })
  video: VideoResponseDto;

  @ApiProperty({ type: UploadSessionDto })
  upload: UploadSessionDto;
}
