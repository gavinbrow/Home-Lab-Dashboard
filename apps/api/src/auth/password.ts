import { randomBytes,scrypt as scryptCallback,timingSafeEqual } from 'node:crypto';
const derive=(password:string,salt:Buffer)=>new Promise<Buffer>((resolve,reject)=>scryptCallback(password,salt,64,{N:32768,r:8,p:1,maxmem:67108864},(error,key)=>error?reject(error):resolve(key)));
export async function hashPassword(password:string){const salt=randomBytes(16);return `scrypt$32768$${salt.toString('base64')}$${(await derive(password,salt)).toString('base64')}`;}
export async function verifyPassword(password:string,encoded:string){
 const [algorithm,cost,salt,expected]=encoded.split('$');
 if(algorithm!=='scrypt'||cost!=='32768'||!salt||!expected)return false;
 const actual=await derive(password,Buffer.from(salt,'base64')),known=Buffer.from(expected,'base64');
 return actual.length===known.length&&timingSafeEqual(actual,known);
}
