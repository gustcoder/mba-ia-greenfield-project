import { Body, Controller, Get, HttpCode, Param, Post } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiParam,
  ApiResponse,
  ApiTags,
  getSchemaPath,
} from '@nestjs/swagger';
import type { JwtPayload } from '../auth/auth.types';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { ApiErrorEnvelope } from '../common/openapi/api-error-envelope.dto';
import { CompleteVideoUploadDto } from './dto/complete-video-upload.dto';
import { InitiateVideoUploadDto } from './dto/initiate-video-upload.dto';
import { SignUploadPartsDto } from './dto/sign-upload-parts.dto';
import { SignedUploadPartsResponseDto } from './dto/signed-upload-parts-response.dto';
import { UploadedPartsResponseDto } from './dto/uploaded-parts-response.dto';
import { VideoResponseDto } from './dto/video-response.dto';
import { VideoUploadResponseDto } from './dto/video-upload-response.dto';
import { VideoUploadsService } from './video-uploads.service';

@ApiTags('videos')
@ApiBearerAuth('access-token')
@Controller('videos')
export class VideosController {
  constructor(private readonly videoUploadsService: VideoUploadsService) {}

  @Post()
  @ApiOperation({
    summary: 'Start a video upload',
    description:
      'Pre-registers the video as a draft in the authenticated user channel and opens a multipart upload in the object storage. The client then signs the parts it needs and sends them straight to the storage.',
  })
  @ApiResponse({
    status: 201,
    description: 'Draft created and multipart upload opened',
    type: VideoUploadResponseDto,
  })
  @ApiResponse({
    status: 400,
    description:
      'Validation failed (VALIDATION_ERROR), unsupported MIME type (UNSUPPORTED_MEDIA_TYPE) or file above the size limit (VIDEO_TOO_LARGE)',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 401,
    description: 'Missing or invalid access token',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async initiateUpload(
    @CurrentUser() user: JwtPayload,
    @Body() dto: InitiateVideoUploadDto,
  ): Promise<VideoUploadResponseDto> {
    return this.videoUploadsService.initiate(user.sub, dto);
  }

  @Post(':videoId/upload/part-urls')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Sign upload part urls',
    description:
      'Signs, on demand, the presigned PUT urls for the requested part numbers of a draft video the user owns. The client sends each part straight to the object storage and keeps the ETag it returns.',
  })
  @ApiParam({ name: 'videoId', description: 'Public video id (11 chars)' })
  @ApiResponse({
    status: 200,
    description: 'Presigned PUT urls and their expiry',
    type: SignedUploadPartsResponseDto,
  })
  @ApiResponse({
    status: 400,
    description:
      'Validation failed (VALIDATION_ERROR) or part number above the upload part count (INVALID_PART_NUMBER)',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 401,
    description: 'Missing or invalid access token',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 404,
    description: 'Video not found or not owned by the user (VIDEO_NOT_FOUND)',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 409,
    description: 'Video is not a draft (INVALID_UPLOAD_STATE)',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 410,
    description:
      'The multipart upload expired in the storage (UPLOAD_EXPIRED); the video becomes failed',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async signParts(
    @CurrentUser() user: JwtPayload,
    @Param('videoId') videoId: string,
    @Body() dto: SignUploadPartsDto,
  ): Promise<SignedUploadPartsResponseDto> {
    return this.videoUploadsService.signParts(user.sub, videoId, dto);
  }

  @Get(':videoId/upload/parts')
  @ApiOperation({
    summary: 'List uploaded parts',
    description:
      'Lists the parts the object storage already received for a draft video the user owns, so an interrupted upload can resume with only the missing parts.',
  })
  @ApiParam({ name: 'videoId', description: 'Public video id (11 chars)' })
  @ApiResponse({
    status: 200,
    description: 'Upload geometry and the parts already stored',
    type: UploadedPartsResponseDto,
  })
  @ApiResponse({
    status: 401,
    description: 'Missing or invalid access token',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 404,
    description: 'Video not found or not owned by the user (VIDEO_NOT_FOUND)',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 409,
    description: 'Video is not a draft (INVALID_UPLOAD_STATE)',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 410,
    description:
      'The multipart upload expired in the storage (UPLOAD_EXPIRED); the video becomes failed',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async listParts(
    @CurrentUser() user: JwtPayload,
    @Param('videoId') videoId: string,
  ): Promise<UploadedPartsResponseDto> {
    return this.videoUploadsService.listUploadedParts(user.sub, videoId);
  }

  @Post(':videoId/upload/complete')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Complete a video upload',
    description:
      'Closes the multipart upload with the parts and ETags the client collected, checks the size of the assembled object and queues the video for processing. Calling it again on a video that is already processing is safe and returns its current state.',
  })
  @ApiParam({ name: 'videoId', description: 'Public video id (11 chars)' })
  @ApiResponse({
    status: 200,
    description: 'Video queued for processing (or its current state)',
    type: VideoResponseDto,
  })
  @ApiResponse({
    status: 400,
    description:
      'Validation failed (VALIDATION_ERROR), parts rejected by the storage (INVALID_UPLOAD_PARTS; the video stays a draft) or assembled file above the size limit (VIDEO_TOO_LARGE; the video becomes failed)',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 401,
    description: 'Missing or invalid access token',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 404,
    description: 'Video not found or not owned by the user (VIDEO_NOT_FOUND)',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 409,
    description: 'Video is failed (INVALID_UPLOAD_STATE)',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 410,
    description:
      'The multipart upload expired in the storage (UPLOAD_EXPIRED); the video becomes failed',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async completeUpload(
    @CurrentUser() user: JwtPayload,
    @Param('videoId') videoId: string,
    @Body() dto: CompleteVideoUploadDto,
  ): Promise<VideoResponseDto> {
    return this.videoUploadsService.complete(user.sub, videoId, dto);
  }
}
