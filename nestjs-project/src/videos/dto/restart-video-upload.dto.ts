import { IsInt, IsOptional, Min } from 'class-validator';

export class RestartVideoUploadDto {
  /**
   * New file size in bytes. Defaults to the size declared when the video was
   * created. The upper limit (10GB) is enforced by the service.
   */
  @IsOptional()
  @IsInt()
  @Min(1)
  size_bytes?: number;
}
