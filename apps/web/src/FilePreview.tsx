import { SafeMarkdown } from './Markdown';
import { useEffect, useMemo, useState } from 'react';
import { Notice } from './App';
export { FILE_LIMIT, TEXT_LIMIT, fromBase64, toBase64, utf8, saveBytes, parseCsv } from './file-codecs';
import { utf8, parseCsv } from './file-codecs';
export function FilePreview({ path, bytes }: { path: string; bytes: Uint8Array }) {
  const extension = path.split('.').pop()?.toLowerCase() ?? '';
  const mime = ({ png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', pdf: 'application/pdf' } as Record<string, string>)[extension];
  const [url, setUrl] = useState('');
  useEffect(() => { if (!mime) { setUrl(''); return; } const value = URL.createObjectURL(new Blob([new Uint8Array(bytes).buffer], { type: mime })); setUrl(value); return () => URL.revokeObjectURL(value); }, [bytes, mime]);
  const text = useMemo(() => utf8(bytes), [bytes]);
  const csv = useMemo(() => extension === 'csv' && text !== undefined ? parseCsv(text.slice(0, 250000)) : null, [text, extension]);
  if (mime?.startsWith('image/')) return <figure className="image-preview"><img src={url} alt={`Preview of ${path}`} /><figcaption>{path} · {bytes.length.toLocaleString()} bytes</figcaption></figure>;
  if (mime === 'application/pdf') return <><iframe className="pdf-preview" title={`PDF preview of ${path}`} src={url} sandbox="" /><p className="small muted">If your browser blocks the isolated PDF viewer, download the original file.</p></>;
  if (['html', 'htm', 'svg'].includes(extension)) return <><Notice>Active content is displayed as source. It cannot execute with your dashboard session.</Notice><pre className="text-preview">{text?.slice(0, 100000) ?? 'Binary or oversized active content — download to inspect.'}</pre></>;
  if (csv) return <><Notice>Preview limited to 100 data rows, 20 columns and 250,000 input characters. {csv.truncated || text!.length > 250000 ? 'Additional content is omitted.' : ''}</Notice><div className="table-wrap"><table><thead><tr>{csv.rows[0]?.map((cell, i) => <th key={i}>{cell || `Column ${i + 1}`}</th>)}</tr></thead><tbody>{csv.rows.slice(1).map((row, i) => <tr key={i}>{row.map((cell, j) => <td key={j}>{cell}</td>)}</tr>)}</tbody></table></div></>;
  if (extension === 'md' && text !== undefined) return <>{text.length>100000&&<Notice>Markdown preview is limited to 100,000 characters. Download preserves the complete file.</Notice>}<SafeMarkdown text={text.slice(0,100000)}/></>;
  if (text !== undefined) { let display = text; if (extension === 'json') { try { display = JSON.stringify(JSON.parse(text), null, 2); } catch { /* Show invalid JSON as supplied. */ } } return <pre className="text-preview">{display.slice(0, 100000)}{display.length > 100000 ? '\n… Preview truncated; download contains the complete bytes.' : ''}</pre>; }
  return <Notice>This format has no safe preview, or exceeds the 1 MiB text preview limit. Download preserves the original bytes.</Notice>;
}
