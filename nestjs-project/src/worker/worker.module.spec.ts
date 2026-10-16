import { Test } from '@nestjs/testing';
import { VideoProcessingProcessor } from '../videos/processing/video-processing.processor';
import { WorkerModule } from './worker.module';

describe('WorkerModule', () => {
  it('should compile with the processor wired to the database, storage, queue and media services', async () => {
    const module = await Test.createTestingModule({
      imports: [WorkerModule],
    }).compile();

    expect(module.get(VideoProcessingProcessor)).toBeInstanceOf(
      VideoProcessingProcessor,
    );
    await module.close();
  }, 30000);
});
