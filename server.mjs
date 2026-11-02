import http from 'node:http';
import { readFile } from 'node:fs/promises';
const html = await readFile(new URL('./index.html', import.meta.url));
const port = Number(process.env.PORT || 3000);
http.createServer((req,res)=>{
  if(req.url === '/' || req.url?.startsWith('/?') || req.url === '/index.html'){
    res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-cache'});
    res.end(html);
  } else if(req.url === '/health'){
    res.writeHead(200,{'Content-Type':'text/plain'});res.end('ok');
  } else {res.writeHead(404);res.end('Not found');}
}).listen(port,'0.0.0.0',()=>console.log(`Live Samurai on ${port}`));
