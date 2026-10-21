// Read files from an operations-booked, never-started inspection container.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {execFileSync}=require('node:child_process');
const [label,container,expectedImage]=process.argv.slice(2);
if(!/^[a-z0-9-]{1,80}$/.test(label??'')||!/^[a-f0-9]{64}$/.test(container??'')||!/^sha256:[a-f0-9]{64}$/.test(expectedImage??''))throw Error('Explicit booked label/container/image required');
const root=path.resolve(__dirname,'../..'),copied=path.join(__dirname,'image-inspection',label);
if(fs.existsSync(copied))throw Error('Inspection copy already exists; use a fresh evidence label');
const docker=(...args)=>execFileSync('wsl.exe',['-d','Ubuntu','--exec','docker',...args],{windowsHide:true,maxBuffer:8*1024*1024}).toString();
const inspection=JSON.parse(docker('inspect','--format','{{json .}}',container));
if(inspection.Image!==expectedImage||inspection.State.Status!=='created'||!inspection.State.StartedAt.startsWith('0001-'))throw Error('Inspection container/image is not the booked never-started target');
if(inspection.Mounts.length||inspection.HostConfig.NetworkMode!=='none'||!inspection.HostConfig.ReadonlyRootfs||!inspection.Config.User)throw Error('Unexpected inspection container isolation');
fs.mkdirSync(copied,{recursive:true});
const linuxPath=file=>path.resolve(file).replaceAll('\\','/').replace(/^([A-Za-z]):/,(_,drive)=>'/mnt/'+drive.toLowerCase());
const directories=['apps','packages'].flatMap(parent=>fs.readdirSync(path.join(root,parent),{withFileTypes:true}).filter(entry=>entry.isDirectory()).map(entry=>parent+'/'+entry.name+'/src')).filter(dir=>fs.existsSync(path.join(root,dir)));
const copiedDirectories=[...directories,'deploy','db/migrations'];
for(const dir of copiedDirectories){const parent=path.dirname(path.join(copied,dir));fs.mkdirSync(parent,{recursive:true});docker('cp',container+':/app/'+dir,linuxPath(parent));}
const configured=['package.json','package-lock.json','tsconfig.json','tsconfig.base.json','.dockerignore'];
for(const parent of ['apps','packages'])for(const entry of fs.readdirSync(path.join(root,parent),{withFileTypes:true}).filter(entry=>entry.isDirectory()))for(const name of fs.readdirSync(path.join(root,parent,entry.name)).filter(name=>/^(package\.json|tsconfig.*\.json|index\.html)$/.test(name)||/\.config\.(ts|js|mjs|cjs|json)$/.test(name)))configured.push(parent+'/'+entry.name+'/'+name);
for(const name of configured.filter(name=>fs.existsSync(path.join(root,name)))){const destination=path.join(copied,name);fs.mkdirSync(path.dirname(destination),{recursive:true});docker('cp',container+':/app/'+name,linuxPath(destination));}
const wanted=name=>/\.(ts|tsx|css|svg|html|json|py|sql|sh|yml|yaml|cjs|mjs)$/.test(name)||/\/(Dockerfile[^/]*|Caddyfile)$/.test(name);
const collect=(base,dir,includeTests)=>{const result=[];function walk(relative){for(const entry of fs.readdirSync(path.join(base,relative),{withFileTypes:true})){const name=relative+'/'+entry.name;if(entry.isDirectory()){if(!entry.name.startsWith('.')&&entry.name!=='__pycache__')walk(name);}else if(wanted(name)&&(includeTests||!name.includes('.test.')))result.push(name);}}if(fs.existsSync(path.join(base,dir)))walk(dir);return result;};
const names=new Set(configured.filter(name=>fs.existsSync(path.join(root,name))));
for(const dir of copiedDirectories)for(const base of [root,copied])for(const name of collect(base,dir,dir==='deploy'))names.add(name);
const hash=(base,name)=>fs.existsSync(path.join(base,name))?crypto.createHash('sha256').update(fs.readFileSync(path.join(base,name),'utf8').replace(/\r\n/g,'\n')).digest('hex'):null;
const files=[...names].sort().map(name=>{const image=hash(copied,name),checkout=hash(root,name);return {path:name,image_lf_sha256:image,checkout_lf_sha256:checkout,identical:image!==null&&image===checkout};});
const result={captured_at:new Date().toISOString(),scope:'Built image filesystem only; inspection container never started, no service/runtime deployment claim',image_id:expectedImage,inspection_container:container,inspection_state:inspection.State.Status,files};
fs.writeFileSync(path.join(__dirname,'staged-image-source-comparison-'+label+'.json'),JSON.stringify(result,null,2)+'\n');
process.stdout.write(JSON.stringify({image:expectedImage,files:files.length,changed:files.filter(file=>!file.identical).map(file=>file.path)})+'\n');
