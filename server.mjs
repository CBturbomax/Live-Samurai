import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { WebSocketServer, WebSocket } from 'ws';

const html = await readFile(new URL('./index.html', import.meta.url));
const port = Number(process.env.PORT || 3000);
// The key lives only in the server environment (Railway variable), never in the public source.
const GEMINI_KEY = (process.env.GEMINI_API_KEY || '').trim();
const GEMINI_URL = process.env.GEMINI_WS_URL || 'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent';

const GEMINI_REST = (process.env.GEMINI_REST_URL || 'https://generativelanguage.googleapis.com').replace(/\/$/, '');

// Second-pass translation: a text model re-translates each finished segment with context.
const refineModels = new Map(); // api key -> Promise<model name | null>
function pickRefineModel(key) {
  if (process.env.GEMINI_REFINE_MODEL) return Promise.resolve(process.env.GEMINI_REFINE_MODEL.replace(/^(?!models\/)/, 'models/'));
  if (!refineModels.has(key)) {
    refineModels.set(key, (async () => {
      const r = await fetch(GEMINI_REST + '/v1beta/models?pageSize=1000', { headers: { 'x-goog-api-key': key }, signal: AbortSignal.timeout(15000) });
      if (!r.ok) throw new Error('model list HTTP ' + r.status);
      const names = ((await r.json()).models || []).filter(m => (m.supportedGenerationMethods || []).includes('generateContent')).map(m => m.name);
      // Prefer the newest stable Flash model (fast enough for captions), then a Flash preview, then Pro.
      const newest = re => names.filter(n => re.test(n)).sort((a, b) => parseFloat(b.match(/gemini-([\d.]+)/)[1]) - parseFloat(a.match(/gemini-([\d.]+)/)[1]))[0];
      return newest(/^models\/gemini-[\d.]+-flash$/) || newest(/^models\/gemini-[\d.]+-flash-preview$/) || newest(/^models\/gemini-[\d.]+-pro$/) || null;
    })().catch(err => { console.error('Refine model lookup failed:', err.message); setTimeout(() => refineModels.delete(key), 60000); return null; }));
  }
  return refineModels.get(key);
}
if (GEMINI_KEY) pickRefineModel(GEMINI_KEY).then(m => console.log('Refine model:', m));

const REFINE_SYSTEM = `You are a professional interpreter working at investor and company meetings. You receive one segment of a live speech-recognition transcript and must return its Korean translation.
- Translate accurately and naturally, in the polite spoken register used in business meetings (합니다체/해요체).
- The transcript may contain recognition errors. Use the earlier segments and the glossary to fix obvious errors, but do not invent content.
- Keep every number, unit, date, company name, product name and ticker exact. Follow the glossary when it gives a Korean term.
- Do not summarize, add, omit or explain. If the segment ends mid-sentence, translate only what is there.
- Return JSON with two fields: "transcript" (the current segment in its original language with recognition errors corrected, filler words like "uh" removed) and "translation" (its Korean translation).`;
const REFINE_AUDIO_NOTE = `[Audio]
A recording of roughly this part of the meeting is attached. It may begin a few seconds before the current segment and include the end of the previous one. Listen to it to correct words, names, abbreviations and numbers that the speech recognizer got wrong in the current segment. The transcript defines where the segment begins and ends: do not transcribe or translate speech outside it.`;
const REFINE_SCHEMA = { type: 'OBJECT', properties: { transcript: { type: 'STRING' }, translation: { type: 'STRING' } }, required: ['transcript', 'translation'] };

// 16 kHz mono 16-bit PCM -> WAV
function wavFromPcm(pcm) {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + pcm.length, 4); h.write('WAVEfmt ', 8); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(16000, 24); h.writeUInt32LE(32000, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write('data', 36); h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}

function readJson(req, limit = 3 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0; const parts = [];
    req.on('data', d => { size += d.length; if (size > limit) { reject(new Error('too large')); req.destroy(); } else parts.push(d); });
    req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(parts).toString() || '{}')); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}
const clip = (v, n) => String(v || '').slice(0, n);
async function handleRefine(req, res) {
  const send = (code, body) => { res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(body)); };
  try {
    let sameSite = false; try { sameSite = new URL(req.headers.origin).host === req.headers.host; } catch {}
    if (!sameSite) return send(403, { error: 'forbidden' });
    const key = GEMINI_KEY || clip(req.headers['x-gemini-key'], 200).trim();
    if (!key) return send(503, { error: 'no key' });
    const body = await readJson(req);
    const text = clip(body.text, 4000).trim();
    if (!text) return send(400, { error: 'empty' });
    const model = await pickRefineModel(key);
    if (!model) return send(503, { error: 'no model' });
    const context = (Array.isArray(body.context) ? body.context : []).slice(-3)
      .map(c => `원문: ${clip(c.original, 1500)}\n번역: ${clip(c.translation, 1500)}`).join('\n\n');
    let wav = '';
    if (typeof body.audio === 'string' && body.audio.length > 4000 && body.audio.length < 2_600_000) {
      const pcm = Buffer.from(body.audio, 'base64');
      wav = wavFromPcm(pcm.subarray(0, pcm.length & ~1)).toString('base64');
    }
    const promptFor = withAudio => [
      body.glossary ? `[Glossary]\n${clip(body.glossary, 2000)}` : '',
      context ? `[Earlier segments, for context only]\n${context}` : '',
      body.live ? `[Rough live translation of the current segment, may be incomplete]\n${clip(body.live, 4000)}` : '',
      withAudio ? REFINE_AUDIO_NOTE : '',
      `[Current segment${body.languageCode ? ' (' + clip(body.languageCode, 20) + ')' : ''}, as recognized]\n${text}`,
    ].filter(Boolean).join('\n\n');
    const call = withAudio => fetch(`${GEMINI_REST}/v1beta/${model}:generateContent`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key }, signal: AbortSignal.timeout(25000),
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: REFINE_SYSTEM }] },
        contents: [{ role: 'user', parts: [{ text: promptFor(withAudio) }, ...(withAudio ? [{ inlineData: { mimeType: 'audio/wav', data: wav } }] : [])] }],
        generationConfig: { temperature: 0.2, responseMimeType: 'application/json', responseSchema: REFINE_SCHEMA },
      }),
    });
    let usedAudio = Boolean(wav), r = await call(usedAudio);
    if (!r.ok && usedAudio && r.status !== 429) { // the audio attempt failed: fall back to the text-only second pass
      console.error('Refine with audio failed:', r.status, clip(await r.text(), 300)); usedAudio = false; r = await call(false);
    }
    if (!r.ok) { const detail = clip(await r.text(), 300); console.error('Refine failed:', r.status, detail); return send(r.status === 429 ? 429 : 502, { error: 'gemini ' + r.status, detail }); }
    const data = await r.json();
    const raw = (data.candidates?.[0]?.content?.parts || []).filter(p => !p.thought).map(p => p.text || '').join('').trim();
    let out; try { out = JSON.parse(raw); } catch { out = { translation: raw }; }
    send(200, { translation: clip(out.translation, 6000).trim(), transcript: clip(out.transcript, 6000).trim(), model, usedAudio });
  } catch (err) { console.error('Refine error:', err.message); send(502, { error: String(err.message || err) }); }
}

const server = http.createServer(async (req, res) => {
  if (req.url === '/' || req.url?.startsWith('/?') || req.url === '/index.html') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
    res.end(html);
  } else if (req.url === '/config') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ serverKey: Boolean(GEMINI_KEY), refineModel: GEMINI_KEY ? await pickRefineModel(GEMINI_KEY) : null }));
  } else if (req.url === '/refine' && req.method === 'POST') {
    await handleRefine(req, res);
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
