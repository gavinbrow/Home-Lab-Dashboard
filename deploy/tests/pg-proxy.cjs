// Explicit isolated integration fixture only. No credentials in arguments/logs.
const net = require('node:net');
net.createServer(client => {
  const upstream = net.connect(5432, 'postgres');
  client.pipe(upstream); upstream.pipe(client);
  client.on('error', () => upstream.destroy());
  upstream.on('error', () => client.destroy());
}).listen(5432, '0.0.0.0');
