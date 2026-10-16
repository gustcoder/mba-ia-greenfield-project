import { Test } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import { randomUUID } from 'crypto';
import { readFile, readdir } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import storageConfig from '../config/storage.config';
import { StorageModule } from '../storage/storage.module';
import { StorageService } from '../storage/storage.service';
import {
  FIXTURE_VIDEO,
  createVideoFixtures,
  type VideoFixtures,
} from '../test/video-fixtures';
import { FfmpegRunner } from './ffmpeg-runner';
import { FfmpegExecutionError, InvalidMediaError } from './media.errors';
import { MediaModule } from './media.module';
import { MediaService } from './media.service';

// ffprobe/ffmpeg are the container's real binaries; the storage is the real
// MinIO, to prove the presigned internal URL is readable without a local copy.
describe('MediaService (ffmpeg + MinIO)', () => {
  let service: MediaService;
  let storage: StorageService;
  let fixtures: VideoFixtures;
  let closeModule: () => Promise<void>;
  const keys: string[] = [];

  // Width and height of a JPEG, read from its SOF marker.
  function jpegSize(buffer: Buffer): { width: number; height: number } {
    let offset = 2;
    while (offset < buffer.length) {
      const marker = buffer[offset + 1];
      const length = buffer.readUInt16BE(offset + 2);
      if (marker >= 0xc0 && marker <= 0xc3) {
        return {
          height: buffer.readUInt16BE(offset + 5),
          width: buffer.readUInt16BE(offset + 7),
        };
      }
      offset += 2 + length;
    }
    throw new Error('no SOF marker');
  }

  async function upload(path: string, contentType: string): Promise<string> {
    const key = `videos/${randomUUID()}/original`;
    keys.push(key);
    await storage.putObject(key, await readFile(path), contentType);
    return storage.presignInternalGet(key, 600);
  }

  beforeAll(async () => {
    fixtures = await createVideoFixtures();
    const module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [storageConfig] }),
        StorageModule,
        MediaModule,
      ],
    }).compile();
    service = module.get(MediaService);
    storage = module.get(StorageService);
    closeModule = () => module.close();
  });

  afterAll(async () => {
    await storage.deletePrefix('videos/');
    await fixtures.cleanup();
    await closeModule();
  });

  describe('probe', () => {
    it('should read duration, dimensions and codec of a real 3 s 640x360 video', async () => {
      const result = await service.probe(fixtures.videoPath);

      expect(result.durationSeconds).toBeCloseTo(
        FIXTURE_VIDEO.durationSeconds,
        0,
      );
      expect(result).toMatchObject({
        width: FIXTURE_VIDEO.width,
        height: FIXTURE_VIDEO.height,
        videoCodec: FIXTURE_VIDEO.codec,
      });
      expect(result.sizeBytes).toBeGreaterThan(0);
      const { format, streams } = result.metadata as {
        format: { format_name: string };
        streams: { codec_type: string }[];
      };
      expect(typeof format.format_name).toBe('string');
      expect(streams.map((stream) => stream.codec_type)).toEqual(['video']);
    });

    // ffprobe reads plain text as ANSI "video" (tty demuxer): the container
    // allowlist is what keeps such a file out.
    it('should reject a text file that ffprobe itself reads as a tty video', async () => {
      await expect(service.probe(fixtures.notVideoPath)).rejects.toBeInstanceOf(
        InvalidMediaError,
      );
    });

    it('should read an object through its internal presigned url without writing it to disk', async () => {
      const before = (await readdir(tmpdir())).sort();
      const url = await upload(fixtures.videoPath, 'video/mp4');

      const result = await service.probe(url);

      expect(result).toMatchObject({
        width: FIXTURE_VIDEO.width,
        height: FIXTURE_VIDEO.height,
      });
      expect((await readdir(tmpdir())).sort()).toEqual(before);
    });

    it('should reject a non-video object read through a presigned url', async () => {
      const url = await upload(fixtures.notVideoPath, 'text/plain');

      await expect(service.probe(url)).rejects.toBeInstanceOf(
        InvalidMediaError,
      );
    });

    it('should treat an unreachable object as a transient failure, not invalid media', async () => {
      const url = await storage.presignInternalGet(
        `videos/${randomUUID()}/missing`,
        600,
      );

      const failure: unknown = await service
        .probe(url)
        .catch((e: unknown) => e);

      expect(failure).toBeInstanceOf(FfmpegExecutionError);
      expect(failure).not.toBeInstanceOf(InvalidMediaError);
      expect((failure as Error).message).not.toContain('X-Amz-Signature');
    });
  });

  describe('extractThumbnail', () => {
    it('should return a JPEG frame no wider than 1280px with the aspect ratio kept', async () => {
      const jpeg = await service.extractThumbnail(
        fixtures.videoPath,
        FIXTURE_VIDEO.durationSeconds,
      );

      expect([...jpeg.subarray(0, 2)]).toEqual([0xff, 0xd8]);
      const { width, height } = jpegSize(jpeg);
      expect(width).toBeLessThanOrEqual(1280);
      expect(width / height).toBeCloseTo(
        FIXTURE_VIDEO.width / FIXTURE_VIDEO.height,
        1,
      );
    });

    it('should extract a frame from the internal presigned url without a local copy', async () => {
      const url = await upload(fixtures.videoPath, 'video/mp4');

      const jpeg = await service.extractThumbnail(
        url,
        FIXTURE_VIDEO.durationSeconds,
      );

      expect([...jpeg.subarray(0, 2)]).toEqual([0xff, 0xd8]);
    });

    it('should fall back to frame 0 when 10% of a wrong duration is past the end', async () => {
      const jpeg = await service.extractThumbnail(fixtures.videoPath, 1000);

      expect([...jpeg.subarray(0, 2)]).toEqual([0xff, 0xd8]);
    });

    it('should fail when the input cannot be read', async () => {
      await expect(
        service.extractThumbnail(join(tmpdir(), 'does-not-exist.mp4'), 3),
      ).rejects.toBeInstanceOf(FfmpegExecutionError);
    });
  });

  describe('FfmpegRunner', () => {
    const runner = new FfmpegRunner();

    it('should kill a process that exceeds the timeout and fail with a timeout error', async () => {
      const startedAt = Date.now();

      const failure: unknown = await runner
        .run('sleep', ['30'], 300)
        .catch((e: unknown) => e);

      expect(failure).toBeInstanceOf(FfmpegExecutionError);
      expect((failure as FfmpegExecutionError).reason).toBe('timeout');
      expect(Date.now() - startedAt).toBeLessThan(5000);
    });

    it('should reject with the exit code and stderr when the binary fails', async () => {
      const failure: unknown = await runner
        .run('sh', ['-c', 'echo oops >&2; exit 3'], 5000)
        .catch((e: unknown) => e);

      expect(failure).toMatchObject({
        reason: 'exit-code',
        exitCode: 3,
        stderr: expect.stringContaining('oops') as string,
      });
    });

    it('should fail with a spawn error when the binary does not exist', async () => {
      await expect(
        runner.run('definitely-not-a-binary', [], 1000),
      ).rejects.toMatchObject({ reason: 'spawn' });
    });

    it('should redact the query string of urls found in stderr', async () => {
      const failure: unknown = await runner
        .run(
          'sh',
          [
            '-c',
            'echo "http://minio:9000/b/k?X-Amz-Signature=secret: 403" >&2; exit 1',
          ],
          5000,
        )
        .catch((e: unknown) => e);

      const error = failure as FfmpegExecutionError;
      expect(error.message).not.toContain('secret');
      expect(error.stderr).not.toContain('secret');
      expect(error.stderr).toContain('http://minio:9000/b/k?<redacted>');
    });

    it('should return stdout as a buffer on success', async () => {
      const result = await runner.run('echo', ['hello'], 5000);

      expect(result.stdout.toString()).toBe('hello\n');
    });
  });
});
