import { DomainException } from '../../common/exceptions/domain.exception';

// Named UnsupportedVideoType* (not UnsupportedMediaType*) so it can never be
// auto-imported by mistake in place of Nest's HTTP UnsupportedMediaTypeException.
export class UnsupportedVideoTypeException extends DomainException {
  constructor() {
    super('UNSUPPORTED_MEDIA_TYPE', 400, 'Unsupported video type');
  }
}

export class VideoTooLargeException extends DomainException {
  constructor() {
    super('VIDEO_TOO_LARGE', 400, 'Video exceeds the maximum allowed size');
  }
}

export class VideoNotFoundException extends DomainException {
  constructor() {
    super('VIDEO_NOT_FOUND', 404, 'Video not found');
  }
}

export class InvalidUploadStateException extends DomainException {
  constructor() {
    super(
      'INVALID_UPLOAD_STATE',
      409,
      'Operation not allowed in the current video status',
    );
  }
}

export class InvalidPartNumberException extends DomainException {
  constructor() {
    super('INVALID_PART_NUMBER', 400, 'Part number out of range');
  }
}

export class UploadExpiredException extends DomainException {
  constructor() {
    super('UPLOAD_EXPIRED', 410, 'Upload session expired');
  }
}

export class InvalidUploadPartsException extends DomainException {
  constructor() {
    super(
      'INVALID_UPLOAD_PARTS',
      400,
      'Uploaded parts are invalid or incomplete',
    );
  }
}

export class VideoNotReadyException extends DomainException {
  constructor() {
    super('VIDEO_NOT_READY', 409, 'Video is not ready yet');
  }
}
