export type FileEntry={path:string;name?:string;kind?:string;type?:string;size_bytes?:number;sha256?:string;modified_at?:string;writable?:boolean};
export type FileContent={path:string;content_base64:string;sha256:string;size_bytes:number};
export type Instructions={instructions:string;revision:number;source:string};
export type RootBinding={workspace_id:string;approved_root_id:string;canonical_root:string;runtime_path:string;type:'native'|'container';writable:boolean;quota_bytes:number;revision:number;environment_id:string|null;environment_generation:number|null;runtime_id?:string|null;image_digest?:string|null};
