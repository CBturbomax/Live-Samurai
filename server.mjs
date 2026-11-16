import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { WebSocketServer, WebSocket } from 'ws';

const html = await readFile(new URL('./index.html', import.meta.url));
const port = Number(process.env.PORT || 3000);
// The key lives only in the server environment (Railway variable), never in the public source.
const GEMINI_KEY = (process.env.GEMINI_API_KEY || '').trim();
const GEMINI_URL = process.env.GEMINI_WS_URL || 'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent';

const server = http.createServer((req, res) => {
  if (req.url === '/' || req.url?.startsWith('/?') || req.url === '/index.html') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
    res.end(html);
  } else if (req.url === '/config') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ serverKey: Boolean(GEMINI_KEY) }));
  } else if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'text/plain' }); res.end('ok');
  } else { res.writeHead(404); res.end('Not found'); }
});

// Close codes that may not be sent in a close frame are mapped to 1011.
const safeCode = code => (code >= 3000 && code <= 4999) || [1000, 1001, 1002, 1003, 1007, 1008, 1009, 1011].includes(code) ? code : 1011;
const safeReason = reason => Buffer.from(String(reason || '')).subarray(0, 120).toString();

const wss = new WebSocketServer({ noServer: true, maxPayload: 4 * 1024 * 1024 });

server.on('upgrade', (req, socket, head) => {
  const sameSite = () => { try { return new URL(req.headers.origin).host === req.headers.host; } catch { return false; } };
  if (req.url !== '/live' || !GEMINI_KEY || !sameSite()) { socket.destroy(); return; }
  wss.handleUpgrade(req, socket, head, client => {
    const upstream = new WebSocket(GEMINI_URL + '?key=' + encodeURIComponent(GEMINI_KEY));
    const queue = [];
    client.on('message', (data, isBinary) => {
      if (upstream.readyState === WebSocket.OPEN) upstream.send(data, { binary: isBinary });
      else if (queue.length < 200) queue.push([data, isBinary]);
    });
    upstream.on('open', () => { for (const [data, isBinary] of queue.splice(0)) upstream.send(data, { binary: isBinary }); });
    upstream.on('message', (data, isBinary) => { if (client.readyState === WebSocket.OPEN) client.send(data, { binary: isBinary }); });
    upstream.on('close', (code, reason) => { if (client.readyState <= WebSocket.OPEN) client.close(safeCode(code), safeReason(reason)); });
    upstream.on('error', err => { console.error('Gemini upstream error:', err.message); if (client.readyState <= WebSocket.OPEN) client.close(1011, 'Gemini upstream error'); });
    client.on('close', () => { if (upstream.readyState <= WebSocket.OPEN) upstream.close(); });
    client.on('error', () => upstream.terminate());
  });
});

server.listen(port, '0.0.0.0', () => console.log(`Live Samurai on ${port} · server key ${GEMINI_KEY ? 'set' : 'not set'}`));
