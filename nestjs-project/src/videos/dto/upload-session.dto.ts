import { ApiProperty } from '@nestjs/swagger';

export class UploadSessionDto {
  @ApiProperty({ example: 104857600 })
  part_size_bytes: number;

  @ApiProperty({ example: 3 })
  part_count: number;
}
