import { ApiProperty } from '@nestjs/swagger';

export class SignedUploadPartDto {
  @ApiProperty({ example: 1 })
  part_number: number;

  @ApiProperty({
    description: 'Presigned PUT url; send the part bytes straight to it.',
  })
  url: string;
}

export class SignedUploadPartsResponseDto {
  @ApiProperty({ type: [SignedUploadPartDto] })
  parts: SignedUploadPartDto[];

  @ApiProperty({ format: 'date-time', description: 'When the urls expire.' })
  expires_at: string;
}
