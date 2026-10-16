export interface StorageUploadedPart {
  partNumber: number;
  etag: string;
  sizeBytes: number;
}

export interface StorageCompletedPart {
  partNumber: number;
  etag: string;
}

export interface StorageObjectHead {
  contentLength: number;
  contentType?: string;
}

export interface StoragePresignGetOptions {
  attachmentFilename?: string;
}
