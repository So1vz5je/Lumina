import { describe, expect, it } from 'vitest';
import type { WindowsDatabaseColumn } from './types';
import {
  buildChangedWindowsDatabaseValues,
  buildWindowsDatabaseRowIdentity,
  getWindowsDatabaseEditableColumns,
  validateWindowsDatabaseRowValues,
} from './mutation';

const columns: WindowsDatabaseColumn[] = [
  { name: 'id', dataType: 'int', nullable: false, key: 'PRI', extra: 'auto_increment' },
  { name: 'email', dataType: 'varchar(255)', nullable: false },
  { name: 'nickname', dataType: 'varchar(255)', nullable: true },
  { name: 'created_at', dataType: 'timestamp', nullable: false, defaultValue: 'CURRENT_TIMESTAMP', extra: 'generated' },
];

describe('windows database mutation helpers', () => {
  it('derives editable columns without generated columns', () => {
    expect(getWindowsDatabaseEditableColumns(columns)).toStrictEqual([
      expect.objectContaining({ name: 'email', required: true, generated: false }),
      expect.objectContaining({ name: 'nickname', required: false, generated: false }),
    ]);
  });

  it('builds row identity from primary or unique columns', () => {
    expect(buildWindowsDatabaseRowIdentity(columns, { id: '7', email: 'a@example.com' })).toStrictEqual({
      columns: [{ name: 'id', value: '7' }],
    });
  });

  it('returns null identity when no primary or unique key is present', () => {
    expect(
      buildWindowsDatabaseRowIdentity(
        [{ name: 'email', dataType: 'varchar(255)', nullable: false }],
        { email: 'a@example.com' },
      ),
    ).toBeNull();
  });

  it('blocks empty required fields before insert or update submission', () => {
    expect(validateWindowsDatabaseRowValues(getWindowsDatabaseEditableColumns(columns), { email: '' })).toBe(
      '字段不能为空',
    );
    expect(
      validateWindowsDatabaseRowValues(getWindowsDatabaseEditableColumns(columns), { email: 'a@example.com' }),
    ).toBeNull();
  });

  it('sends only changed update values', () => {
    expect(
      buildChangedWindowsDatabaseValues(
        { email: 'old@example.com', nickname: 'old' },
        { email: 'new@example.com', nickname: 'old' },
      ),
    ).toStrictEqual({ email: 'new@example.com' });
  });
});
