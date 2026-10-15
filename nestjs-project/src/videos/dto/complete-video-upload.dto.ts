import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsInt,
  IsNotEmpty,
  IsString,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';

// S3 allows at most 10,000 parts per multipart upload.
const MAX_PARTS = 10000;

export class CompleteUploadPartDto {
  /** Part number (1-based) that was sent to the storage. */
  @IsInt()
  @Min(1)
  @Max(MAX_PARTS)
  part_number: number;

  /** ETag exactly as the storage returned it for that part (quotes included). */
  @IsString()
  @IsNotEmpty()
  etag: string;
}

export class CompleteVideoUploadDto {
  /** Every part of the upload with the ETag the storage returned for it. */
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_PARTS)
  @ValidateNested({ each: true })
  @Type(() => CompleteUploadPartDto)
  parts: CompleteUploadPartDto[];
}
