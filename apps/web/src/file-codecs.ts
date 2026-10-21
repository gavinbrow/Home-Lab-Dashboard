export const FILE_LIMIT = 16 * 1024 * 1024;
export const TEXT_LIMIT = 1024 * 1024;
export function fromBase64(value: string): Uint8Array { return Uint8Array.from(atob(value), c => c.charCodeAt(0)); }
export function toBase64(bytes: Uint8Array): string {
  let result = ''; for (let offset = 0; offset < bytes.length; offset += 32768) result += String.fromCharCode(...bytes.subarray(offset, offset + 32768));
  return btoa(result);
}
export function utf8(bytes: Uint8Array): string | undefined {
  if (bytes.length > TEXT_LIMIT || bytes.includes(0)) return undefined;
  try { return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); } catch { return undefined; }
}
export function saveBytes(bytes: Uint8Array, filename: string, mime = 'application/octet-stream') {
  const url = URL.createObjectURL(new Blob([new Uint8Array(bytes).buffer], { type: mime }));
  const link = document.createElement('a'); link.href = url; link.download = filename; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export function parseCsv(text: string, maximumRows = 101, maximumColumns = 20): { rows: string[][]; truncated: boolean } {
  const rows: string[][] = []; let row: string[] = []; let cell = ''; let quoted = false; let truncated = false;
  const addCell = () => { if (row.length < maximumColumns) row.push(cell.slice(0, 2000)); else truncated = true; cell = ''; };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"') { if (quoted && text[i + 1] === '"') { cell += '"'; i++; } else quoted = !quoted; }
    else if (!quoted && ch === ',') addCell();
    else if (!quoted && (ch === '\n' || ch === '\r')) { if (ch === '\r' && text[i + 1] === '\n') i++; addCell(); rows.push(row); row = []; if (rows.length >= maximumRows) { truncated = i < text.length - 1; break; } }
    else cell += ch;
  }
  if ((cell.length || row.length) && rows.length < maximumRows) { addCell(); rows.push(row); }
  return { rows, truncated };
}
