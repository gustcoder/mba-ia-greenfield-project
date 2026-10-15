import {
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

export class InitiateVideoUploadDto {
  /** Original file name, including extension. */
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  filename: string;

  /**
   * MIME type of the file. Must be one of video/mp4, video/quicktime,
   * video/webm or video/x-matroska (checked by the service, so the client can
   * tell it apart from a malformed body).
   */
  @IsString()
  @IsNotEmpty()
  mime_type: string;

  /** File size in bytes. The upper limit (10GB) is enforced by the service. */
  @IsInt()
  @Min(1)
  size_bytes: number;

  /** Video title. Defaults to the file name without its extension. */
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  title?: string;
}
