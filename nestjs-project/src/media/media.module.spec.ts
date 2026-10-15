import { Test } from '@nestjs/testing';
import { FfmpegRunner } from './ffmpeg-runner';
import { MediaModule } from './media.module';
import { MediaService } from './media.service';

describe('MediaModule', () => {
  it('should compile and expose MediaService wired to the real runner', async () => {
    const module = await Test.createTestingModule({
      imports: [MediaModule],
    }).compile();

    expect(module.get(MediaService)).toBeInstanceOf(MediaService);
    expect(module.get(FfmpegRunner)).toBeInstanceOf(FfmpegRunner);
    await module.close();
  });
});
