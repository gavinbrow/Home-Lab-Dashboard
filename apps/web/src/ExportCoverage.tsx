export type ExportEntry={path:string;kind:string;size_bytes:number};
export type ExportPreview={expected_manifest_hash:string;exclusions:string[];included_paths:ExportEntry[];estimated_source_bytes:number;consistency:string};
export function ExportCoverage({entries}:{entries:ExportEntry[]}) {
 return <details><summary>Included paths</summary>{entries.length?<div className="table-wrap"><table><thead><tr><th>Root-relative path</th><th>Kind</th><th>Source bytes</th></tr></thead><tbody>{entries.map(entry=><tr key={entry.path}><td className="mono">{entry.path}</td><td>{entry.kind}</td><td>{entry.size_bytes.toLocaleString()}</td></tr>)}</tbody></table></div>:<p>No paths included.</p>}</details>;
}
