import { mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { FfmpegRunner } from '../media/ffmpeg-runner';

export const FIXTURE_VIDEO = {
  durationSeconds: 3,
  width: 640,
  height: 360,
  codec: 'h264',
} as const;

export interface VideoFixtures {
  videoPath: string;
  notVideoPath: string;
  cleanup: () => Promise<void>;
}

// Generated with the container's own ffmpeg, so no binary sample is versioned.
// The default muxing keeps the moov atom at the end of the file, which is the
// harder case for a ranged read.
export async function createVideoFixtures(): Promise<VideoFixtures> {
  const dir = await mkdtemp(join(tmpdir(), 'streamtube-fixtures-'));
  const videoPath = join(dir, 'sample.mp4');
  const notVideoPath = join(dir, 'notes.txt');

  await new FfmpegRunner().run(
    'ffmpeg',
    [
      '-v',
      'error',
      '-y',
      '-f',
      'lavfi',
      '-i',
      `testsrc=duration=${FIXTURE_VIDEO.durationSeconds}:size=${FIXTURE_VIDEO.width}x${FIXTURE_VIDEO.height}:rate=25`,
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
      videoPath,
    ],
    60_000,
  );
  await writeFile(notVideoPath, 'this is not a video\n'.repeat(50));

  return {
    videoPath,
    notVideoPath,
    cleanup: () => rm(dir, { recursive: true }),
  };
}
