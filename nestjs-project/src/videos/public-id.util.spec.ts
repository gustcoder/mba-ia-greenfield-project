import { generatePublicId, isPublicIdFormat } from './public-id.util';

describe('generatePublicId', () => {
  it('should return 11 characters in the base64url alphabet', () => {
    for (let i = 0; i < 200; i++) {
      expect(generatePublicId()).toMatch(/^[A-Za-z0-9_-]{11}$/);
    }
  });

  it('should return distinct ids across a large batch', () => {
    const ids = new Set(Array.from({ length: 10_000 }, generatePublicId));
    expect(ids.size).toBe(10_000);
  });

  it('should produce ids that pass isPublicIdFormat', () => {
    expect(isPublicIdFormat(generatePublicId())).toBe(true);
  });
});

describe('isPublicIdFormat', () => {
  it.each(['dQw4w9WgXcQ', 'AAAAAAAAAAA', '___________', '-----------'])(
    'should accept %s',
    (value) => {
      expect(isPublicIdFormat(value)).toBe(true);
    },
  );

  it.each([
    ['too short', 'abc'],
    ['too long', 'dQw4w9WgXcQa'],
    ['empty', ''],
    ['outside the alphabet', 'dQw4w9WgXc!'],
    ['standard base64 chars', 'dQw4w9WgX+/'],
    ['with a space', 'dQw4w9 WgXc'],
    ['with a newline suffix', 'dQw4w9WgXcQ\n'],
  ])('should reject a value that is %s', (_label, value) => {
    expect(isPublicIdFormat(value)).toBe(false);
  });

  it.each([undefined, null, 12345678901, {}, ['dQw4w9WgXcQ']])(
    'should reject the non-string value %p',
    (value) => {
      expect(isPublicIdFormat(value)).toBe(false);
    },
  );
});
