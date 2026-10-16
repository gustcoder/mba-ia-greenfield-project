import { Injectable } from '@nestjs/common';
import { FfmpegRunner } from './ffmpeg-runner';
import {
  ALLOWED_CONTAINER_FORMATS,
  FFMPEG_BINARY,
  FFPROBE_BINARY,
  PROBE_TIMEOUT_MS,
  THUMBNAIL_MAX_WIDTH,
  THUMBNAIL_SEEK_RATIO,
  THUMBNAIL_TIMEOUT_MS,
} from './media.constants';
import { FfmpegExecutionError, InvalidMediaError } from './media.errors';
import type {
  FfprobeFormat,
  FfprobeOutput,
  FfprobeStream,
  ProbeResult,
} from './media.types';

// Only these keys are kept in the stored summary: ffprobe also reports free
// form `tags` (title, encoder, location...) that are not ours to persist.
const FORMAT_SUMMARY_KEYS = [
  'format_name',
  'format_long_name',
  'duration',
  'size',
  'bit_rate',
] as const;
const STREAM_SUMMARY_KEYS = [
  'index',
  'codec_type',
  'codec_name',
  'profile',
  'width',
  'height',
  'pix_fmt',
  'r_frame_rate',
  'avg_frame_rate',
  'duration',
  'bit_rate',
  'channels',
  'sample_rate',
  'channel_layout',
] as const;

const NOT_A_MEDIA_FILE = /Invalid data found when processing input/i;
const JPEG_SIGNATURE = Buffer.from([0xff, 0xd8]);

export function thumbnailSeekSeconds(durationSeconds: number): number {
  return Math.max(0, durationSeconds * THUMBNAIL_SEEK_RATIO);
}

// `input` is a local path or an http(s) URL; with a URL ffmpeg reads the
// object by ranged requests, so the video is never copied to disk.
@Injectable()
export class MediaService {
  constructor(private readonly runner: FfmpegRunner) {}

  async probe(input: string): Promise<ProbeResult> {
    const output = await this.runProbe(input);
    this.assertAllowedContainer(output.format);
    const video = (output.streams ?? []).find(
      (stream) =>
        stream.codec_type === 'video' && !stream.disposition?.attached_pic,
    );
    if (!video?.codec_name || !video.width || !video.height) {
      throw new InvalidMediaError('No video stream found');
    }
    const format = output.format ?? {};
    const durationSeconds = Number(format.duration ?? video.duration);
    if (!Number.isFinite(durationSeconds) || durationSeconds < 0) {
      throw new InvalidMediaError('The video has no readable duration');
    }

    return {
      durationSeconds,
      width: video.width,
      height: video.height,
      videoCodec: video.codec_name,
      sizeBytes: Number(format.size ?? 0),
      metadata: this.summarize(format, output.streams ?? []),
    };
  }

  // One frame at 10% of the duration; frame 0 when that fails or is empty.
  async extractThumbnail(
    input: string,
    durationSeconds: number,
  ): Promise<Buffer> {
    const seek = thumbnailSeekSeconds(durationSeconds);
    try {
      return await this.grabFrame(input, seek);
    } catch (error) {
      if (seek === 0 || !(error instanceof FfmpegExecutionError)) throw error;
      return this.grabFrame(input, 0);
    }
  }

  private assertAllowedContainer(format: FfprobeFormat = {}): void {
    const names = (format.format_name ?? '').split(',');
    if (
      !names.some((name) => ALLOWED_CONTAINER_FORMATS.some((a) => a === name))
    ) {
      throw new InvalidMediaError(
        `Unsupported container format: ${format.format_name ?? 'unknown'}`,
      );
    }
  }

  private async runProbe(input: string): Promise<FfprobeOutput> {
    let stdout: Buffer;
    try {
      ({ stdout } = await this.runner.run(
        FFPROBE_BINARY,
        [
          '-v',
          'error',
          '-print_format',
          'json',
          '-show_format',
          '-show_streams',
          '-i',
          input,
        ],
        PROBE_TIMEOUT_MS,
      ));
    } catch (error) {
      // ffprobe says so when the bytes are not a media file: permanent. Any
      // other failure (network, timeout, missing binary) may be transient and
      // is left to the caller's retry policy.
      if (
        error instanceof FfmpegExecutionError &&
        error.reason === 'exit-code' &&
        NOT_A_MEDIA_FILE.test(error.stderr)
      ) {
        throw new InvalidMediaError('The file is not a recognizable media', {
          cause: error,
        });
      }
      throw error;
    }
    try {
      return JSON.parse(stdout.toString('utf8')) as FfprobeOutput;
    } catch (error) {
      throw new InvalidMediaError('ffprobe returned an unreadable result', {
        cause: error,
      });
    }
  }

  private async grabFrame(input: string, seekSeconds: number): Promise<Buffer> {
    const { stdout } = await this.runner.run(
      FFMPEG_BINARY,
      [
        '-v',
        'error',
        '-nostdin',
        '-ss',
        seekSeconds.toFixed(3),
        '-i',
        input,
        '-frames:v',
        '1',
        '-vf',
        `scale='min(${THUMBNAIL_MAX_WIDTH},iw)':-2`,
        '-f',
        'image2',
        '-c:v',
        'mjpeg',
        'pipe:1',
      ],
      THUMBNAIL_TIMEOUT_MS,
    );
    if (!stdout.subarray(0, 2).equals(JPEG_SIGNATURE)) {
      throw new FfmpegExecutionError(
        'ffmpeg produced no frame',
        'exit-code',
        '',
        0,
      );
    }
    return stdout;
  }

  private summarize(
    format: FfprobeFormat,
    streams: FfprobeStream[],
  ): Record<string, unknown> {
    const pick = (source: object, keys: readonly string[]) =>
      Object.fromEntries(
        keys
          .filter((key) => (source as Record<string, unknown>)[key] != null)
          .map((key) => [key, (source as Record<string, unknown>)[key]]),
      );
    return {
      format: pick(format, FORMAT_SUMMARY_KEYS),
      streams: streams.map((stream) => pick(stream, STREAM_SUMMARY_KEYS)),
    };
  }
}
