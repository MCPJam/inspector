require('net').createServer(c=>{const u=require('net').connect(8765,'fixture');c.pipe(u).pipe(c);c.on('error',()=>{});u.on('error',()=>{})}).listen(18765,'127.0.0.1');
