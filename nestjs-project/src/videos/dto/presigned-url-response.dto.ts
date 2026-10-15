import { ApiProperty } from '@nestjs/swagger';

export class PresignedUrlResponseDto {
  @ApiProperty({
    description: 'Presigned GET url served by the object storage.',
  })
  url: string;

  @ApiProperty({
    format: 'date-time',
    description: 'When the url stops working.',
  })
  expires_at: string;
}
