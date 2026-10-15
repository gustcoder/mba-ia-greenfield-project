import { deriveTitleFromFilename, truncateTitle } from './video-title.util';

describe('deriveTitleFromFilename', () => {
  it.each([
    ['aula.mp4', 'aula'],
    ['Minha Aula.mov', 'Minha Aula'],
    ['archive.tar.mp4', 'archive.tar'],
    ['no-extension', 'no-extension'],
    ['  spaced name .webm', 'spaced name'],
    ['folder/clip.mkv', 'clip'],
  ])('should turn %p into %p', (filename, title) => {
    expect(deriveTitleFromFilename(filename)).toBe(title);
  });

  it('should fall back to the whole name when only an extension would remain', () => {
    expect(deriveTitleFromFilename('.mp4')).toBe('.mp4');
  });

  it('should cut a long name to 100 characters', () => {
    const title = deriveTitleFromFilename(`${'a'.repeat(150)}.mp4`);
    expect(title).toBe('a'.repeat(100));
  });
});

describe('truncateTitle', () => {
  it('should keep a title of exactly 100 characters untouched', () => {
    expect(truncateTitle('b'.repeat(100))).toBe('b'.repeat(100));
  });

  it('should count code points so a surrogate pair is never split', () => {
    const emojis = '🎬'.repeat(101);

    const title = truncateTitle(emojis);

    expect(Array.from(title)).toHaveLength(100);
    expect(title).toBe('🎬'.repeat(100));
  });
});
