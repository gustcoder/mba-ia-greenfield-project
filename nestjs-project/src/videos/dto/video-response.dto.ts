import { ApiProperty } from '@nestjs/swagger';
import { VideoStatus } from '../entities/video-status.enum';

export class VideoResponseDto {
  @ApiProperty({
    example: 'dQw4w9WgXcQ',
    description: 'Public video id (URL).',
  })
  id: string;

  @ApiProperty({ example: 'aula' })
  title: string;

  @ApiProperty({ enum: VideoStatus, example: VideoStatus.DRAFT })
  status: VideoStatus;

  @ApiProperty({ type: String, nullable: true, example: null })
  failure_reason: string | null;

  @ApiProperty({ example: 'aula.mp4' })
  original_filename: string;

  @ApiProperty({ example: 'video/mp4' })
  mime_type: string;

  @ApiProperty({ example: 314572800 })
  size_bytes: number;

  @ApiProperty({ type: Number, nullable: true, example: 12.5 })
  duration_seconds: number | null;

  @ApiProperty({ type: Number, nullable: true, example: 1280 })
  width: number | null;

  @ApiProperty({ type: Number, nullable: true, example: 720 })
  height: number | null;

  @ApiProperty({ type: String, nullable: true, example: 'h264' })
  video_codec: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Presigned GET url of the thumbnail; null until processed.',
  })
  thumbnail_url: string | null;

  @ApiProperty({ format: 'date-time' })
  created_at: string;

  @ApiProperty({ format: 'date-time' })
  updated_at: string;
}
