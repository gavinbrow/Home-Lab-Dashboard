// Content hashes only; no source contents, configuration, or credentials.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const root = path.resolve(__dirname,'../..');
const label=process.argv[2];
if(!/^[a-z0-9-]{1,80}$/.test(label??''))throw Error('A bounded evidence label is required');
const files=[];
function walk(relative){for(const entry of fs.readdirSync(path.join(root,relative),{withFileTypes:true})){const name=relative+'/'+entry.name;if(entry.isDirectory())walk(name);else {const bytes=fs.readFileSync(path.join(root,name));files.push({path:name,bytes:bytes.length,sha256:crypto.createHash('sha256').update(bytes).digest('hex')});}}}
for(const parent of ['apps','packages'])for(const directory of fs.readdirSync(path.join(root,parent),{withFileTypes:true}).filter(entry=>entry.isDirectory()).map(entry=>parent+'/'+entry.name+'/src'))if(fs.existsSync(path.join(root,directory)))walk(directory);
for(const name of ['package.json','package-lock.json','tests/integration/linux-sentinel.test.ts','tests/integration/model-free-survival.test.ts','tests/integration/survival-fixture.mjs','tests/integration/helpers/sentinel-worker.ts','tests/integration/helpers/precursor-worker.ts','tests/integration/helpers/linux-stack.ts','tests/integration/helpers/ui-runtime.ts']){const bytes=fs.readFileSync(path.join(root,name));files.push({path:name,bytes:bytes.length,sha256:crypto.createHash('sha256').update(bytes).digest('hex')});}
const buildFiles=['tsconfig.json','tsconfig.base.json','.dockerignore','deploy/Dockerfile','deploy/entrypoint.sh','deploy/compose.yml',...fs.readdirSync(path.join(root,'db/migrations')).filter(name=>name.endsWith('.sql')).map(name=>'db/migrations/'+name)];
for(const parent of ['apps','packages'])for(const entry of fs.readdirSync(path.join(root,parent),{withFileTypes:true}).filter(entry=>entry.isDirectory()))for(const name of fs.readdirSync(path.join(root,parent,entry.name)).filter(name=>/^(package\.json|tsconfig.*\.json|index\.html)$/.test(name)||/\.config\.(ts|js|mjs|cjs|json)$/.test(name)))buildFiles.push(parent+'/'+entry.name+'/'+name);
for(const name of buildFiles)if(fs.existsSync(path.join(root,name))){const bytes=fs.readFileSync(path.join(root,name));files.push({path:name,bytes:bytes.length,sha256:crypto.createHash('sha256').update(bytes).digest('hex')});}
function walkToolSources(relative){for(const entry of fs.readdirSync(path.join(root,relative),{withFileTypes:true})){const name=relative+'/'+entry.name;if(entry.isDirectory()){if(!entry.name.startsWith('.')&&!['bin','node_modules','__pycache__'].includes(entry.name))walkToolSources(name);}else if(/\.(?:py|sql|sh|ps1|yml|yaml|cjs|mjs|ts|go)$/.test(name)||/\/(?:Dockerfile[^/]*|Caddyfile|go\.mod|go\.sum)$/.test(name)){if(!files.some(file=>file.path===name)){const bytes=fs.readFileSync(path.join(root,name));files.push({path:name,bytes:bytes.length,sha256:crypto.createHash('sha256').update(bytes).digest('hex')});}}}}
for(const directory of ['deploy','agent','tests/integration'])walkToolSources(directory);
files.sort((a,b)=>a.path.localeCompare(b.path));
const result={captured_at:new Date().toISOString(),label,scope:'Content hashes of API, worker, packages, host Go source, deployment/restore tools, actual test drivers, migrations and build configuration; no secrets or source bytes',files};
fs.writeFileSync(path.join(__dirname,`source-manifest-${label}.json`),JSON.stringify(result,null,2)+'\n');
process.stdout.write(JSON.stringify({label,captured_at:result.captured_at,files:files.length})+'\n');
