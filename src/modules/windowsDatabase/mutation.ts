import type {
  WindowsDatabaseColumn,
  WindowsDatabaseEditableColumn,
  WindowsDatabaseRowIdentity,
} from './types';

function isIdentityColumn(column: WindowsDatabaseColumn): boolean {
  const key = (column.key ?? '').toLowerCase();
  return key.includes('pri') || key.includes('primary') || key.includes('uni') || key.includes('unique');
}

function isGeneratedColumn(column: WindowsDatabaseColumn): boolean {
  const extra = `${column.extra ?? ''} ${column.defaultValue ?? ''}`.toLowerCase();
  return (
    extra.includes('auto_increment') ||
    extra.includes('identity') ||
    extra.includes('generated') ||
    extra.includes('rowguid')
  );
}

export function getWindowsDatabaseEditableColumns(columns: WindowsDatabaseColumn[]): WindowsDatabaseEditableColumn[] {
  return columns
    .map((column) => {
      const generated = isGeneratedColumn(column);
      const identity = isIdentityColumn(column);
      return {
        ...column,
        generated,
        identity,
        required: !column.nullable && !column.defaultValue && !generated,
      };
    })
    .filter((column) => !column.generated);
}

export function buildWindowsDatabaseRowIdentity(
  columns: WindowsDatabaseColumn[],
  row: Record<string, unknown>,
): WindowsDatabaseRowIdentity | null {
  const identityColumns = columns.filter(isIdentityColumn);
  if (identityColumns.length === 0) {
    return null;
  }

  const identity = identityColumns.flatMap((column) => {
    if (!(column.name in row)) {
      return [];
    }

    const value = row[column.name];
    if (value == null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      return [{ name: column.name, value: value ?? null }];
    }

    return [{ name: column.name, value: String(value) }];
  });

  return identity.length === identityColumns.length ? { columns: identity } : null;
}

export function validateWindowsDatabaseRowValues(
  columns: WindowsDatabaseEditableColumn[],
  values: Record<string, unknown>,
): string | null {
  const missing = columns.find((column) => {
    const value = values[column.name];
    return column.required && (value == null || String(value).trim() === '');
  });

  return missing ? '字段不能为空' : null;
}

export function buildChangedWindowsDatabaseValues(
  original: Record<string, unknown>,
  next: Record<string, unknown>,
): Record<string, string | number | boolean | null> {
  return Object.fromEntries(
    Object.entries(next)
      .filter(([name, value]) => original[name] !== value)
      .map(([name, value]) => [name, normalizeMutationValue(value)]),
  );
}

export function normalizeMutationValue(value: unknown): string | number | boolean | null {
  if (value == null) {
    return null;
  }

  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }

  return String(value);
}
