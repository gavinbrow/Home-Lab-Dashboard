const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const {execFileSync}=require('node:child_process');
const root=path.resolve(__dirname,'../..');
const directories=['apps','packages'].flatMap(parent=>fs.readdirSync(path.join(root,parent),{withFileTypes:true}).filter(entry=>entry.isDirectory()).map(entry=>parent+'/'+entry.name+'/src'));
const configuredFiles=['package.json','package-lock.json','tsconfig.json','tsconfig.base.json','.dockerignore','deploy/Dockerfile','deploy/entrypoint.sh','deploy/compose.yml','deploy/backup-inventory.example.json','deploy/demo/index.html',...fs.readdirSync(path.join(root,'db/migrations')).filter(name=>name.endsWith('.sql')).map(name=>'db/migrations/'+name)];
for(const parent of ['apps','packages'])for(const entry of fs.readdirSync(path.join(root,parent),{withFileTypes:true}).filter(entry=>entry.isDirectory()))for(const name of fs.readdirSync(path.join(root,parent,entry.name)).filter(name=>/^(package\.json|tsconfig.*\.json|index\.html)$/.test(name)||/\.config\.(ts|js|mjs|cjs|json)$/.test(name)))configuredFiles.push(parent+'/'+entry.name+'/'+name);
function deploymentFiles(dir){for(const entry of fs.readdirSync(path.join(root,dir),{withFileTypes:true})){const name=dir+'/'+entry.name;if(entry.isDirectory()){if(!entry.name.startsWith('.')&&entry.name!=='__pycache__')deploymentFiles(name);}else if(/\.(py|sql|sh|yml|yaml|cjs|mjs|ts)$/.test(name)||/\/(Dockerfile[^/]*|Caddyfile)$/.test(name)){if(!configuredFiles.includes(name))configuredFiles.push(name);}}}
deploymentFiles('deploy');
const checkoutFiles=configuredFiles.filter(name=>fs.existsSync(path.join(root,name)));
function walkCheckout(dir){for(const entry of fs.readdirSync(path.join(root,dir),{withFileTypes:true})){const name=dir+'/'+entry.name;if(entry.isDirectory())walkCheckout(name);else if(/\.(ts|tsx|css|svg|html|json)$/.test(name)&&!name.includes('.test.'))checkoutFiles.push(name);}}
for(const directory of directories)if(fs.existsSync(path.join(root,directory)))walkCheckout(directory);
const hash=text=>crypto.createHash('sha256').update(text.replace(/\r\n/g,'\n')).digest('hex');
const code=`const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');const files=[];function walk(dir){for(const e of fs.readdirSync(dir,{withFileTypes:true})){const n=dir+'/'+e.name;if(e.isDirectory())walk(n);else if(/\\.(ts|tsx|css|svg|html|json)$/.test(n)&&!n.includes('.test.'))files.push({path:n,sha256:crypto.createHash('sha256').update(fs.readFileSync(n,'utf8').replace(/\\r\\n/g,'\\n')).digest('hex')});}}for(const d of ${JSON.stringify(directories)})if(fs.existsSync(d))walk(d);process.stdout.write(JSON.stringify(files));`;
const imageFiles=JSON.parse(execFileSync('wsl.exe',['-d','Ubuntu','--exec','docker','exec','homelab-validation-wave2-api-1','node','-e',code],{windowsHide:true,maxBuffer:8*1024*1024}));
const extraCode=`const fs=require('node:fs'),crypto=require('node:crypto');process.stdout.write(JSON.stringify(${JSON.stringify(checkoutFiles)}.map(n=>({path:n,sha256:fs.existsSync(n)?crypto.createHash('sha256').update(fs.readFileSync(n,'utf8').replace(/\\r\\n/g,'\\n')).digest('hex'):null}))));`;
const configuredImageFiles=JSON.parse(execFileSync('wsl.exe',['-d','Ubuntu','--exec','docker','exec','homelab-validation-wave2-api-1','node','-e',extraCode],{windowsHide:true,maxBuffer:8*1024*1024}));
for(const file of configuredImageFiles)if(!imageFiles.some(existing=>existing.path===file.path))imageFiles.push(file);
const files=imageFiles.map(file=>{const full=path.join(root,file.path),current=fs.existsSync(full)?hash(fs.readFileSync(full,'utf8')):null;return {path:file.path,image_lf_sha256:file.sha256,checkout_lf_sha256:current,identical:current!==null&&current===file.sha256};});
const imageId=execFileSync('wsl.exe',['-d','Ubuntu','--exec','docker','inspect','--format','{{.Image}}','homelab-validation-wave2-api-1'],{windowsHide:true}).toString().trim();
const result={captured_at:new Date().toISOString(),image_id:imageId,hash_convention:'UTF8 source with CRLF normalized to LF; test files excluded',files};
const label=process.argv[2]??'wave3d';if(!/^[a-z0-9-]{1,80}$/.test(label))throw Error('Invalid evidence label');
fs.writeFileSync(path.join(__dirname,`image-source-comparison-${label}.json`),JSON.stringify(result,null,2)+'\n');
process.stdout.write(JSON.stringify({captured_at:result.captured_at,files:files.length,changed:files.filter(file=>!file.identical).map(file=>file.path)})+'\n');
