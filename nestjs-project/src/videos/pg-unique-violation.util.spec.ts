import { QueryFailedError } from 'typeorm';
import { isUniqueViolationOnColumn } from './pg-unique-violation.util';

const queryFailed = (driverError: object): QueryFailedError =>
  new QueryFailedError(
    'INSERT',
    [],
    Object.assign(new Error('x'), driverError),
  );

describe('isUniqueViolationOnColumn', () => {
  it('should match a unique violation reported on the column', () => {
    const error = queryFailed({
      code: '23505',
      detail: 'Key (public_id)=(abc) already exists.',
    });
    expect(isUniqueViolationOnColumn(error, 'public_id')).toBe(true);
  });

  it('should not match a unique violation on another column', () => {
    const error = queryFailed({
      code: '23505',
      detail: 'Key (id)=(abc) already exists.',
    });
    expect(isUniqueViolationOnColumn(error, 'public_id')).toBe(false);
  });

  it('should not match other database errors or non-database errors', () => {
    const fk = queryFailed({ code: '23503', detail: 'Key (public_id)=(a)' });
    expect(isUniqueViolationOnColumn(fk, 'public_id')).toBe(false);
    expect(isUniqueViolationOnColumn(new Error('boom'), 'public_id')).toBe(
      false,
    );
    expect(isUniqueViolationOnColumn(undefined, 'public_id')).toBe(false);
  });
});
