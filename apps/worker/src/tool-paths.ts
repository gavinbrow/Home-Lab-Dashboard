import {z} from 'zod';
import {relativePath} from '@homelab/storage';
const canonical=(allowRoot:boolean)=>(value:string)=>{try{return relativePath(value,allowRoot)===value;}catch{return false;}};
// Same portable component grammar as @homelab/storage relativePath. Keep the
// expression representable in the offered JSON schema, with no normalization.
const reserved=String.raw`(?:[cC][oO][nN](?:[iI][nN]\$|[oO][uU][tT]\$)?|[pP][rR][nN]|[aA][uU][xX]|[nN][uU][lL]|[cC][oO][mM][0-9¹²³]|[lL][pP][tT][0-9¹²³])`;
const segment=String.raw`(?!${reserved}(?:\.|/|$))[^/\\\x00-\x1f\x7f:<>"|?*]*[^/\\\x00-\x1f\x7f:<>"|?*. ]`;
const relative=String.raw`${segment}(?:/${segment})*`;
const description='Workspace-relative portable path, for example report.txt or outputs/result.bin. Use forward slashes. Maximum 4096 UTF-16 code units (astral characters such as emoji count as two); this runtime limit also applies when JSON Schema maxLength counts fewer Unicode code points. Never use an absolute /workspace/... path, drive letter, backslash, empty/dot/traversal component, trailing dot/space, control character or Windows reserved device name. The path is used exactly as supplied; no stripping or rewriting.';
export const workspaceFilePath=z.string().min(1).max(4096).regex(new RegExp(String.raw`^${relative}$(?![\s\S])`),'Expected a portable workspace-relative path').refine(canonical(false),'Path must satisfy rooted workspace policy without normalization').describe(description);
export const workspaceListPath=z.string().max(4096).regex(new RegExp(String.raw`^(?:${relative})?$(?![\s\S])`),'Expected a portable workspace-relative directory or the empty root path').refine(canonical(true),'Path must satisfy rooted workspace policy without normalization').describe(`${description} For the workspace root use the empty string ""; do not use "." or "/".`).default('');
