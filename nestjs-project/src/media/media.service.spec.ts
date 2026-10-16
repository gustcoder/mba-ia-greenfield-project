import { Test } from '@nestjs/testing';
import { FfmpegRunner } from './ffmpeg-runner';
import { FfmpegExecutionError, InvalidMediaError } from './media.errors';
import { MediaService, thumbnailSeekSeconds } from './media.service';

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);

const ffprobeJson = (overrides: Record<string, unknown> = {}) =>
  Buffer.from(
    JSON.stringify({
      format: {
        format_name: 'mov,mp4,m4a,3gp,3g2,mj2',
        duration: '3.000000',
        size: '12345',
        bit_rate: '32920',
        tags: { title: 'secret title', location: '+10.0+20.0/' },
      },
      streams: [
        {
          index: 0,
          codec_type: 'video',
          codec_name: 'h264',
          width: 640,
          height: 360,
          r_frame_rate: '25/1',
          tags: { handler_name: 'VideoHandler' },
        },
        { index: 1, codec_type: 'audio', codec_name: 'aac', channels: 2 },
      ],
      ...overrides,
    }),
  );

describe('thumbnailSeekSeconds', () => {
  it.each([
    [3, 0.3],
    [100, 10],
    [0, 0],
  ])('should seek to 10%% of a %p second video (%p s)', (duration, seek) => {
    expect(thumbnailSeekSeconds(duration)).toBeCloseTo(seek, 6);
  });
});

describe('MediaService', () => {
  const runner = { run: jest.fn() };
  let service: MediaService;

  beforeEach(async () => {
    runner.run.mockReset();
    const module = await Test.createTestingModule({
      providers: [MediaService, { provide: FfmpegRunner, useValue: runner }],
    }).compile();
    service = module.get(MediaService);
  });

  describe('probe', () => {
    it('should map the ffprobe output to duration, dimensions, codec and size', async () => {
      runner.run.mockResolvedValue({ stdout: ffprobeJson(), stderr: '' });

      const result = await service.probe('/tmp/a.mp4');

      expect(result).toMatchObject({
        durationSeconds: 3,
        width: 640,
        height: 360,
        videoCodec: 'h264',
        sizeBytes: 12345,
      });
    });

    it('should ask ffprobe for json with format and streams, passing the input after -i', async () => {
      runner.run.mockResolvedValue({ stdout: ffprobeJson(), stderr: '' });

      await service.probe('http://minio:9000/b/k?X-Amz-Signature=abc');

      const [binary, args] = runner.run.mock.calls[0] as [string, string[]];
      expect(binary).toBe('ffprobe');
      expect(args).toEqual([
        '-v',
        'error',
        '-print_format',
        'json',
        '-show_format',
        '-show_streams',
        '-i',
        'http://minio:9000/b/k?X-Amz-Signature=abc',
      ]);
    });

    it('should keep a bounded summary of format and streams without free-form tags', async () => {
      runner.run.mockResolvedValue({ stdout: ffprobeJson(), stderr: '' });

      const { metadata } = await service.probe('/tmp/a.mp4');

      expect(metadata).toEqual({
        format: {
          format_name: 'mov,mp4,m4a,3gp,3g2,mj2',
          duration: '3.000000',
          size: '12345',
          bit_rate: '32920',
        },
        streams: [
          {
            index: 0,
            codec_type: 'video',
            codec_name: 'h264',
            width: 640,
            height: 360,
            r_frame_rate: '25/1',
          },
          { index: 1, codec_type: 'audio', codec_name: 'aac', channels: 2 },
        ],
      });
      expect(JSON.stringify(metadata)).not.toContain('secret title');
    });

    it.each(['tty', 'image2', 'gif', undefined])(
      'should reject a container outside the allowed formats (%p) even with a video stream',
      async (formatName) => {
        runner.run.mockResolvedValue({
          stdout: ffprobeJson({
            format: { format_name: formatName, duration: '0.2', size: '1000' },
          }),
          stderr: '',
        });

        await expect(service.probe('/tmp/notes.txt')).rejects.toBeInstanceOf(
          InvalidMediaError,
        );
      },
    );

    it.each(['mov,mp4,m4a,3gp,3g2,mj2', 'matroska,webm'])(
      'should accept the %s container',
      async (formatName) => {
        runner.run.mockResolvedValue({
          stdout: ffprobeJson({
            format: { format_name: formatName, duration: '3', size: '10' },
          }),
          stderr: '',
        });

        await expect(service.probe('/tmp/a.mp4')).resolves.toMatchObject({
          videoCodec: 'h264',
        });
      },
    );

    it('should reject a file with only audio streams as invalid media', async () => {
      runner.run.mockResolvedValue({
        stdout: ffprobeJson({
          streams: [{ index: 0, codec_type: 'audio', codec_name: 'mp3' }],
        }),
        stderr: '',
      });

      await expect(service.probe('/tmp/a.mp3')).rejects.toBeInstanceOf(
        InvalidMediaError,
      );
    });

    it('should not take cover art (attached picture) for a video stream', async () => {
      runner.run.mockResolvedValue({
        stdout: ffprobeJson({
          streams: [
            { index: 0, codec_type: 'audio', codec_name: 'mp3' },
            {
              index: 1,
              codec_type: 'video',
              codec_name: 'mjpeg',
              width: 500,
              height: 500,
              disposition: { attached_pic: 1 },
            },
          ],
        }),
        stderr: '',
      });

      await expect(service.probe('/tmp/a.mp3')).rejects.toBeInstanceOf(
        InvalidMediaError,
      );
    });

    it('should reject an output without any stream', async () => {
      runner.run.mockResolvedValue({
        stdout: Buffer.from('{}'),
        stderr: '',
      });

      await expect(service.probe('/tmp/x')).rejects.toBeInstanceOf(
        InvalidMediaError,
      );
    });

    it('should fall back to the stream duration when the format has none', async () => {
      runner.run.mockResolvedValue({
        stdout: ffprobeJson({
          format: { format_name: 'matroska,webm', size: '10' },
          streams: [
            {
              codec_type: 'video',
              codec_name: 'vp9',
              width: 10,
              height: 10,
              duration: '2.5',
            },
          ],
        }),
        stderr: '',
      });

      await expect(service.probe('/tmp/a.webm')).resolves.toMatchObject({
        durationSeconds: 2.5,
      });
    });

    it('should reject a video without a readable duration', async () => {
      runner.run.mockResolvedValue({
        stdout: ffprobeJson({
          format: { format_name: 'mov,mp4', size: '10', duration: 'N/A' },
        }),
        stderr: '',
      });

      await expect(service.probe('/tmp/a.webm')).rejects.toBeInstanceOf(
        InvalidMediaError,
      );
    });

    it('should turn ffprobe "Invalid data" into InvalidMediaError', async () => {
      runner.run.mockRejectedValue(
        new FfmpegExecutionError(
          'ffprobe exited with code 1',
          'exit-code',
          'x.txt: Invalid data found when processing input',
          1,
        ),
      );

      await expect(service.probe('/tmp/x.txt')).rejects.toBeInstanceOf(
        InvalidMediaError,
      );
    });

    it.each([
      [
        'a network error',
        new FfmpegExecutionError('boom', 'exit-code', 'Connection refused', 1),
      ],
      ['a timeout', new FfmpegExecutionError('boom', 'timeout', '')],
      ['a missing binary', new FfmpegExecutionError('boom', 'spawn', '')],
    ])('should let %s through as a transient error', async (_label, error) => {
      runner.run.mockRejectedValue(error);

      const failure: unknown = await service
        .probe('http://minio:9000/b/k')
        .catch((e: unknown) => e);

      expect(failure).toBe(error);
      expect(failure).not.toBeInstanceOf(InvalidMediaError);
    });

    it('should reject unreadable ffprobe output as invalid media', async () => {
      runner.run.mockResolvedValue({
        stdout: Buffer.from('not json'),
        stderr: '',
      });

      await expect(service.probe('/tmp/x')).rejects.toBeInstanceOf(
        InvalidMediaError,
      );
    });
  });

  describe('extractThumbnail', () => {
    it('should grab one frame at 10% of the duration scaled to at most 1280px', async () => {
      runner.run.mockResolvedValue({ stdout: JPEG, stderr: '' });

      const result = await service.extractThumbnail('/tmp/a.mp4', 50);

      expect(result).toBe(JPEG);
      const [binary, args] = runner.run.mock.calls[0] as [string, string[]];
      expect(binary).toBe('ffmpeg');
      expect(args).toEqual(
        expect.arrayContaining([
          '-ss',
          '5.000',
          '-i',
          '/tmp/a.mp4',
          '-frames:v',
          '1',
          '-vf',
          "scale='min(1280,iw)':-2",
          '-f',
          'image2',
          '-c:v',
          'mjpeg',
          'pipe:1',
        ]),
      );
      expect(args.indexOf('-ss')).toBeLessThan(args.indexOf('-i'));
    });

    it('should retry at frame 0 when the first attempt fails', async () => {
      runner.run
        .mockRejectedValueOnce(
          new FfmpegExecutionError('seek failed', 'exit-code', '', 1),
        )
        .mockResolvedValueOnce({ stdout: JPEG, stderr: '' });

      const result = await service.extractThumbnail('/tmp/a.mp4', 50);

      expect(result).toBe(JPEG);
      expect(runner.run).toHaveBeenCalledTimes(2);
      const secondArgs = (runner.run.mock.calls[1] as [string, string[]])[1];
      expect(secondArgs[secondArgs.indexOf('-ss') + 1]).toBe('0.000');
    });

    it('should retry at frame 0 when the first attempt returns no image', async () => {
      runner.run
        .mockResolvedValueOnce({ stdout: Buffer.alloc(0), stderr: '' })
        .mockResolvedValueOnce({ stdout: JPEG, stderr: '' });

      await expect(service.extractThumbnail('/tmp/a.mp4', 50)).resolves.toBe(
        JPEG,
      );
      expect(runner.run).toHaveBeenCalledTimes(2);
    });

    it('should fail when the frame 0 attempt fails too', async () => {
      runner.run.mockRejectedValue(
        new FfmpegExecutionError('nope', 'exit-code', '', 1),
      );

      await expect(
        service.extractThumbnail('/tmp/a.mp4', 50),
      ).rejects.toBeInstanceOf(FfmpegExecutionError);
      expect(runner.run).toHaveBeenCalledTimes(2);
    });

    it('should not retry when the first attempt is already at frame 0', async () => {
      runner.run.mockResolvedValue({ stdout: Buffer.alloc(0), stderr: '' });

      await expect(
        service.extractThumbnail('/tmp/a.mp4', 0),
      ).rejects.toBeInstanceOf(FfmpegExecutionError);
      expect(runner.run).toHaveBeenCalledTimes(1);
    });
  });
});
