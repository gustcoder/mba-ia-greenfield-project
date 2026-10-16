import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { ALLOWED_VIDEO_MIME_TYPES } from '../videos.constants';

export class InitiateVideoUploadDto {
  /** Original file name, including extension. */
  @ApiProperty({ example: 'aula.mp4', maxLength: 255 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  filename: string;

  /**
   * MIME type of the file. Must be one of video/mp4, video/quicktime,
   * video/webm or video/x-matroska (checked by the service, so the client can
   * tell it apart from a malformed body).
   */
  @ApiProperty({ enum: ALLOWED_VIDEO_MIME_TYPES, example: 'video/mp4' })
  @IsString()
  @IsNotEmpty()
  mime_type: string;

  /** File size in bytes. The upper limit (10GB) is enforced by the service. */
  @ApiProperty({ example: 314572800, minimum: 1 })
  @IsInt()
  @Min(1)
  size_bytes: number;

  /** Video title. Defaults to the file name without its extension. */
  @ApiPropertyOptional({ example: 'Minha aula', minLength: 1, maxLength: 100 })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  title?: string;
}
