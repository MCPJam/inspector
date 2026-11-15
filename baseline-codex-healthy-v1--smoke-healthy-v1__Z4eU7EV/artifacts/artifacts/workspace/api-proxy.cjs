// Local forwarding adapter for SDK loopback HTTP development support.
const http = require('node:http');
const upstream = new URL(process.env.MCPJAM_API_URL);
http.createServer((req, res) => {
  const target = new URL(req.url, upstream.origin);
  const out = http.request(target, {method: req.method, headers: {...req.headers, host: target.host}}, reply => {
    res.writeHead(reply.statusCode, reply.headers);
    reply.pipe(res);
  });
  out.on('error', () => { res.writeHead(502); res.end('Upstream unavailable'); });
  req.pipe(out);
}).listen(8766, '127.0.0.1', () => console.log('Local API adapter listening on 127.0.0.1:8766'));
