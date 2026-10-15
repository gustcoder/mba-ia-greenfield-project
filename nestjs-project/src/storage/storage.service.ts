import { Inject, Injectable, OnModuleDestroy } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  ListPartsCommand,
  PutObjectCommand,
  S3Client,
  UploadPartCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import storageConfig from '../config/storage.config';
import { buildAttachmentDisposition } from './content-disposition';
import {
  DELETE_OBJECTS_BATCH_SIZE,
  STORAGE_INTERNAL_CLIENT,
  STORAGE_PUBLIC_CLIENT,
} from './storage.constants';
import {
  StorageInvalidPartsError,
  StorageObjectNotFoundError,
  StorageUploadNotFoundError,
} from './storage.errors';
import type {
  StorageCompletedPart,
  StorageObjectHead,
  StoragePresignGetOptions,
  StorageUploadedPart,
} from './storage.types';

const INVALID_PARTS_ERROR_NAMES = new Set([
  'InvalidPart',
  'InvalidPartOrder',
  'EntityTooSmall',
]);

const OBJECT_NOT_FOUND_ERROR_NAMES = new Set(['NotFound', 'NoSuchKey']);

@Injectable()
export class StorageService implements OnModuleDestroy {
  private readonly bucket: string;

  constructor(
    @Inject(storageConfig.KEY)
    config: ConfigType<typeof storageConfig>,
    @Inject(STORAGE_INTERNAL_CLIENT)
    private readonly internalClient: S3Client,
    @Inject(STORAGE_PUBLIC_CLIENT)
    private readonly publicClient: S3Client,
  ) {
    this.bucket = config.bucket;
  }

  onModuleDestroy(): void {
    this.internalClient.destroy();
    this.publicClient.destroy();
  }

  async createMultipartUpload(
    key: string,
    contentType: string,
  ): Promise<string> {
    const { UploadId } = await this.internalClient.send(
      new CreateMultipartUploadCommand({
        Bucket: this.bucket,
        Key: key,
        ContentType: contentType,
      }),
    );
    if (!UploadId) {
      throw new Error('Storage did not return an UploadId');
    }
    return UploadId;
  }

  async listParts(
    key: string,
    uploadId: string,
  ): Promise<StorageUploadedPart[]> {
    const parts: StorageUploadedPart[] = [];
    let partNumberMarker: string | undefined;
    try {
      do {
        const page = await this.internalClient.send(
          new ListPartsCommand({
            Bucket: this.bucket,
            Key: key,
            UploadId: uploadId,
            PartNumberMarker: partNumberMarker,
          }),
        );
        for (const part of page.Parts ?? []) {
          parts.push({
            partNumber: part.PartNumber ?? 0,
            etag: part.ETag ?? '',
            sizeBytes: part.Size ?? 0,
          });
        }
        partNumberMarker = page.IsTruncated
          ? page.NextPartNumberMarker
          : undefined;
      } while (partNumberMarker);
    } catch (error) {
      throw this.translateError(error);
    }
    return parts;
  }

  async completeMultipartUpload(
    key: string,
    uploadId: string,
    parts: StorageCompletedPart[],
  ): Promise<void> {
    const ordered = [...parts].sort((a, b) => a.partNumber - b.partNumber);
    try {
      await this.internalClient.send(
        new CompleteMultipartUploadCommand({
          Bucket: this.bucket,
          Key: key,
          UploadId: uploadId,
          MultipartUpload: {
            Parts: ordered.map((part) => ({
              PartNumber: part.partNumber,
              ETag: part.etag,
            })),
          },
        }),
      );
    } catch (error) {
      throw this.translateError(error);
    }
  }

  async abortMultipartUpload(key: string, uploadId: string): Promise<void> {
    try {
      await this.internalClient.send(
        new AbortMultipartUploadCommand({
          Bucket: this.bucket,
          Key: key,
          UploadId: uploadId,
        }),
      );
    } catch (error) {
      throw this.translateError(error);
    }
  }

  presignUploadPart(
    key: string,
    uploadId: string,
    partNumber: number,
    ttlSeconds: number,
  ): Promise<string> {
    return getSignedUrl(
      this.publicClient,
      new UploadPartCommand({
        Bucket: this.bucket,
        Key: key,
        UploadId: uploadId,
        PartNumber: partNumber,
      }),
      { expiresIn: ttlSeconds },
    );
  }

  presignGet(
    key: string,
    ttlSeconds: number,
    options: StoragePresignGetOptions = {},
  ): Promise<string> {
    return getSignedUrl(
      this.publicClient,
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: key,
        ResponseContentDisposition: options.attachmentFilename
          ? buildAttachmentDisposition(options.attachmentFilename)
          : undefined,
      }),
      { expiresIn: ttlSeconds },
    );
  }

  presignInternalGet(key: string, ttlSeconds: number): Promise<string> {
    return getSignedUrl(
      this.internalClient,
      new GetObjectCommand({ Bucket: this.bucket, Key: key }),
      { expiresIn: ttlSeconds },
    );
  }

  async headObject(key: string): Promise<StorageObjectHead> {
    try {
      const head = await this.internalClient.send(
        new HeadObjectCommand({ Bucket: this.bucket, Key: key }),
      );
      return {
        contentLength: head.ContentLength ?? 0,
        contentType: head.ContentType,
      };
    } catch (error) {
      throw this.translateError(error);
    }
  }

  async putObject(
    key: string,
    body: Buffer | Uint8Array | string,
    contentType: string,
  ): Promise<void> {
    await this.internalClient.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: body,
        ContentType: contentType,
      }),
    );
  }

  async deletePrefix(prefix: string): Promise<void> {
    let continuationToken: string | undefined;
    do {
      const page = await this.internalClient.send(
        new ListObjectsV2Command({
          Bucket: this.bucket,
          Prefix: prefix,
          MaxKeys: DELETE_OBJECTS_BATCH_SIZE,
          ContinuationToken: continuationToken,
        }),
      );
      const objects = (page.Contents ?? []).flatMap((object) =>
        object.Key ? [{ Key: object.Key }] : [],
      );
      if (objects.length > 0) {
        await this.internalClient.send(
          new DeleteObjectsCommand({
            Bucket: this.bucket,
            Delete: { Objects: objects, Quiet: true },
          }),
        );
      }
      continuationToken = page.IsTruncated
        ? page.NextContinuationToken
        : undefined;
    } while (continuationToken);
  }

  private translateError(error: unknown): unknown {
    const name = error instanceof Error ? error.name : undefined;
    if (name === 'NoSuchUpload') {
      return new StorageUploadNotFoundError({ cause: error });
    }
    if (name && INVALID_PARTS_ERROR_NAMES.has(name)) {
      return new StorageInvalidPartsError({ cause: error });
    }
    if (name && OBJECT_NOT_FOUND_ERROR_NAMES.has(name)) {
      return new StorageObjectNotFoundError({ cause: error });
    }
    return error;
  }
}
