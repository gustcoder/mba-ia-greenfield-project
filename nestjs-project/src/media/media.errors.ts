// The input is not a usable video. Permanent: retrying cannot fix it.
export class InvalidMediaError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'InvalidMediaError';
  }
}

export type FfmpegFailureReason =
  | 'exit-code'
  | 'timeout'
  | 'spawn'
  | 'output-limit';

// The binary could not produce a result. Whether it is permanent depends on
// the caller (see MediaService.probe); by itself it may be transient.
export class FfmpegExecutionError extends Error {
  constructor(
    message: string,
    readonly reason: FfmpegFailureReason,
    readonly stderr: string,
    readonly exitCode: number | null = null,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'FfmpegExecutionError';
  }
}
