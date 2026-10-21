// Fixed isolated-fixture forwarding only. No destination comes from a request.
// The restored API stays on an internal-only Docker network. The TLS listener
// remains end-to-end mTLS; this process never reads or logs transport contents.
const net=require('node:net');
for(const [listen,target] of [[3013,3000],[3453,3443]])net.createServer(client=>{
 const upstream=net.connect(target,'api');
 client.pipe(upstream);upstream.pipe(client);
 client.on('error',()=>upstream.destroy());upstream.on('error',()=>client.destroy());
}).listen(listen,'0.0.0.0');
