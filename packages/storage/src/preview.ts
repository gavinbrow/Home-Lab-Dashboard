export function sniffMime(bytes: Uint8Array, filename = ''): string {
  const b = Buffer.from(bytes);
  if (b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png';
  if (b.length >= 3 && b[0] === 255 && b[1] === 216 && b[2] === 255) return 'image/jpeg';
  if (b.subarray(0, 6).toString('ascii') === 'GIF87a' || b.subarray(0, 6).toString('ascii') === 'GIF89a') return 'image/gif';
  if (b.subarray(0, 4).toString('ascii') === 'RIFF' && b.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  if (b.subarray(0, 5).toString('ascii') === '%PDF-') return 'application/pdf';
  if (b.includes(0)) return 'application/octet-stream';
  try { new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { return 'application/octet-stream'; }
  if (/\.json$/i.test(filename)) return 'application/json';
  if (/\.csv$/i.test(filename)) return 'text/csv';
  if (/\.md$/i.test(filename)) return 'text/markdown';
  return 'text/plain';
}

function csvPreview(text: string): { rows: string[][]; truncated: boolean } {
  const rows: string[][] = [];
  let row: string[] = [], cell = '', quoted = false, truncated = false;
  const finishCell = () => { if (row.length < 50) row.push(cell); else truncated = true; cell = ''; };
  const finishRow = () => { finishCell(); if (rows.length < 201) rows.push(row); row = []; };
  for (let i = 0; i < text.length; i++) {
    const char = text[i]!;
    if (char === '"') {
      if (quoted && text[i + 1] === '"') { if (cell.length < 8192) cell += '"'; else truncated = true; i++; }
      else if (quoted || cell.length === 0) quoted = !quoted;
      else if (cell.length < 8192) cell += char;
    } else if (!quoted && char === ',') finishCell();
    else if (!quoted && (char === '\n' || char === '\r')) {
      if (char === '\r' && text[i + 1] === '\n') i++;
      finishRow();
      if (rows.length === 201) { truncated ||= i < text.length - 1; break; }
    } else if (cell.length < 8192) cell += char;
    else truncated = true;
  }
  if (quoted) throw new Error('Unclosed quoted CSV field.');
  if (row.length || cell.length) finishRow();
  return { rows, truncated };
}
function boundedJson(value: unknown, depth = 0): unknown {
  if (depth >= 8 && value && typeof value === 'object') return '[Nested preview omitted]';
  if (Array.isArray(value)) return value.slice(0, 200).map(item => boundedJson(item, depth + 1));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).slice(0, 200).map(([key, item]) => [key, boundedJson(item, depth + 1)]));
  return value;
}

/** Returns data only. HTML/SVG never becomes dashboard-origin executable markup. */
export function previewFile(bytes: Uint8Array, path: string) {
  const mime = sniffMime(bytes, path);
  if (bytes.byteLength > 2 * 1024 * 1024 && !mime.startsWith('image/') && mime !== 'application/pdf') return { kind: 'download', mime_type: mime, reason: 'Text preview exceeds 2 MiB.' };
  if (mime.startsWith('image/')) return { kind: 'image', mime_type: mime, content_base64: Buffer.from(bytes).toString('base64') };
  if (mime === 'application/pdf') return { kind: 'pdf', mime_type: mime, content_base64: Buffer.from(bytes).toString('base64') };
  if (mime === 'application/octet-stream') return { kind: 'download', mime_type: mime };
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  if (mime === 'application/json') {
    try { return { kind: 'json', mime_type: mime, text, value: boundedJson(JSON.parse(text)), preview_limits: { depth: 8, entries: 200 } }; }
    catch { return { kind: 'text', mime_type: 'text/plain', text, reason: 'Invalid JSON.' }; }
  }
  if (mime === 'text/csv') {
    try { return { kind: 'csv', mime_type: mime, ...csvPreview(text), preview_limits: { rows: 201, columns: 50, cell_characters: 8192 } }; }
    catch { return { kind: 'text', mime_type: 'text/plain', text, reason: 'Malformed CSV quoting.' }; }
  }
  // Markdown is plain source; the UI may render only through its sanitizer.
  return { kind: mime === 'text/markdown' ? 'markdown' : 'text', mime_type: mime, text };
}
