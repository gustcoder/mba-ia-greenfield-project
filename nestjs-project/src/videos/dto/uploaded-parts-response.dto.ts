import { ApiProperty } from '@nestjs/swagger';

export class UploadedPartDto {
  @ApiProperty({ example: 1 })
  part_number: number;

  @ApiProperty({ example: '"9bb58f26192e4ba00f01e2e7b136bbd8"' })
  etag: string;

  @ApiProperty({ example: 104857600 })
  size_bytes: number;
}

export class UploadedPartsResponseDto {
  @ApiProperty({ example: 104857600 })
  part_size_bytes: number;

  @ApiProperty({ example: 3 })
  part_count: number;

  @ApiProperty({ type: [UploadedPartDto] })
  uploaded_parts: UploadedPartDto[];
}
