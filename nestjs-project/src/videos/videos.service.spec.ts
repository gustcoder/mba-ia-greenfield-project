import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { VideoNotFoundException } from './exceptions/video.exceptions';
import { Video } from './entities/video.entity';
import { VideosService } from './videos.service';

describe('VideosService.findOwnedByPublicId', () => {
  const repository = { findOne: jest.fn() };
  let service: VideosService;

  beforeEach(async () => {
    repository.findOne.mockReset();
    const module = await Test.createTestingModule({
      providers: [
        VideosService,
        { provide: getRepositoryToken(Video), useValue: repository },
      ],
    }).compile();
    service = module.get(VideosService);
  });

  it.each([
    'short',
    'toolongtoolongtoolong',
    'invalid!!!!',
    '',
    'dQw4w9WgXc\n',
  ])(
    'should answer not found for the malformed id %p without querying the database',
    async (id) => {
      await expect(
        service.findOwnedByPublicId('user-1', id),
      ).rejects.toBeInstanceOf(VideoNotFoundException);

      expect(repository.findOne).not.toHaveBeenCalled();
    },
  );

  it('should look the video up by public id restricted to the owner user', async () => {
    const video = { id: 'uuid-1' } as Video;
    repository.findOne.mockResolvedValue(video);

    await expect(
      service.findOwnedByPublicId('user-1', 'dQw4w9WgXcQ'),
    ).resolves.toBe(video);

    expect(repository.findOne).toHaveBeenCalledWith({
      where: { public_id: 'dQw4w9WgXcQ', channel: { user_id: 'user-1' } },
    });
  });

  it('should answer not found when no row matches', async () => {
    repository.findOne.mockResolvedValue(null);

    await expect(
      service.findOwnedByPublicId('user-1', 'dQw4w9WgXcQ'),
    ).rejects.toBeInstanceOf(VideoNotFoundException);
  });
});
