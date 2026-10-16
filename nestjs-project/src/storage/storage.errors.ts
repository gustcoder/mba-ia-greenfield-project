export class StorageUploadNotFoundError extends Error {
  constructor(options?: ErrorOptions) {
    super('Multipart upload not found in storage', options);
    this.name = 'StorageUploadNotFoundError';
  }
}

export class StorageInvalidPartsError extends Error {
  constructor(options?: ErrorOptions) {
    super('Multipart upload parts rejected by storage', options);
    this.name = 'StorageInvalidPartsError';
  }
}

export class StorageObjectNotFoundError extends Error {
  constructor(options?: ErrorOptions) {
    super('Object not found in storage', options);
    this.name = 'StorageObjectNotFoundError';
  }
}
