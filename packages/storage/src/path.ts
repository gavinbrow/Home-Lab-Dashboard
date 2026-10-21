/** Portable archive/API paths; never resolve these on the API host for workspace IO. */
export function relativePath(value: string, allowRoot = false): string {
  if (allowRoot && value === '') return '';
  if (!value || value.length > 4096 || /[\\\x00-\x1f\x7f:]/u.test(value) || value.startsWith('/')) {
    throw Object.assign(new Error('invalid_relative_path'), { code: 'invalid_relative_path', statusCode: 400 });
  }
  const parts = value.split('/');
  for (const part of parts) {
    if (!part || part === '.' || part === '..' || /[. ]$/u.test(part) || /[<>"|?*]/u.test(part)
      || /^(con|prn|aux|nul|conin\$|conout\$|com[0-9¹²³]|lpt[0-9¹²³])(?:\.|$)/iu.test(part)) {
      throw Object.assign(new Error('invalid_relative_path'), { code: 'invalid_relative_path', statusCode: 400 });
    }
  }
  return value;
}

export function assertHash(hash: string): string {
  if (!/^[a-f0-9]{64}$/u.test(hash)) throw Object.assign(new Error('invalid_sha256'), { code: 'invalid_sha256', statusCode: 400 });
  return hash;
}
