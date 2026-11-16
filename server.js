// AW Tawla — private rooms server (static hosting + WebSocket relay)
const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
const ROOT = __dirname;
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.md': 'text/plain; charset=utf-8'
};

const server = http.createServer((req, res) => {
  let p;
  try { p = decodeURIComponent((req.url || '/').split('?')[0]); } catch (e) { p = '/'; }
  if (p === '/') p = '/index.html';
  if (p === '/health') { res.writeHead(200, { 'Content-Type': 'text/plain' }); res.end('ok'); return; }
  const f = path.normalize(path.join(ROOT, p));
  if (!f.startsWith(ROOT)) { res.writeHead(403); res.end(); return; }
  fs.readFile(f, (e, d) => {
    if (e) { res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('not found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(f).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(d);
  });
});

const wss = new WebSocketServer({ server, path: '/ws' });
const rooms = new Map(); // code -> {sockets:[ws|null,ws|null], pids:[string|null,string|null], sync:object|null, emptySince:number|null}
const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
function makeCode() { let c = ''; for (let i = 0; i < 4; i++) c += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)]; return c; }
function send(ws, obj) { if (ws && ws.readyState === 1) { try { ws.send(JSON.stringify(obj)); } catch (e) {} } }
function live(ws) { return !!(ws && ws.readyState === 1); }

function joinRoom(ws, code, playerId, seat) {
  const r = rooms.get(code);
  ws.room = code; ws.seat = seat; ws.pid = playerId;
  r.pids[seat] = playerId; r.sockets[seat] = ws; r.emptySince = null;
}

wss.on('connection', ws => {
  ws.room = null; ws.seat = null; ws.pid = null; ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  ws.on('message', raw => {
    let m; try { m = JSON.parse(raw); } catch (e) { return; }
    if (m.t === 'create') {
      let code = makeCode(); while (rooms.has(code)) code = makeCode();
      rooms.set(code, { sockets: [null, null], pids: [null, null], sync: null, emptySince: null });
      joinRoom(ws, code, String(m.playerId || ''), 0);
      send(ws, { t: 'created', code, seat: 0 });
    } else if (m.t === 'join') {
      const code = String(m.code || '').toUpperCase().trim();
      const r = rooms.get(code);
      if (!r) { send(ws, { t: 'error', msg: 'room_not_found' }); return; }
      let seat = -1;
      if (r.pids[0] === String(m.playerId || '')) seat = 0;
      else if (r.pids[1] === String(m.playerId || '')) seat = 1;
      else if (!live(r.sockets[0])) seat = 0;
      else if (!live(r.sockets[1])) seat = 1;
      if (seat === -1) { send(ws, { t: 'error', msg: 'room_full' }); return; }
      joinRoom(ws, code, String(m.playerId || ''), seat);
      const peer = r.sockets[1 - seat];
      const peerOnline = live(peer);
      send(ws, { t: 'joined', code, seat, peerOnline });
      if (peerOnline) {
        send(peer, { t: 'peer-online' });
        // mid-game rejoin: ask the seated peer for a fresh state snapshot
        if (r.sync) send(peer, { t: 'request-sync' });
      } else if (r.sync) {
        send(ws, { t: 'msg', data: r.sync });
      }
    } else if (m.t === 'relay') {
      const r = rooms.get(ws.room); if (!r || ws.seat === null) return;
      if (m.data && m.data.t === 'sync') r.sync = m.data;
      send(r.sockets[1 - ws.seat], { t: 'msg', data: m.data });
    } else if (m.t === 'store') {
      const r = rooms.get(ws.room); if (r && m.data) r.sync = m.data;
    }
  });
  ws.on('close', () => {
    const r = rooms.get(ws.room); if (!r) return;
    if (r.sockets[ws.seat] === ws) r.sockets[ws.seat] = null;
    if (!live(r.sockets[0]) && !live(r.sockets[1])) r.emptySince = Date.now();
    else send(r.sockets[1 - ws.seat], { t: 'peer-offline' });
  });
});

setInterval(() => {
  wss.clients.forEach(ws => { if (!ws.isAlive) return ws.terminate(); ws.isAlive = false; try { ws.ping(); } catch (e) {} });
}, 30000);

// drop rooms empty for over 30 minutes
setInterval(() => {
  const now = Date.now();
  for (const [code, r] of rooms) {
    if (!live(r.sockets[0]) && !live(r.sockets[1])) {
      if (!r.emptySince) r.emptySince = now;
      if (now - r.emptySince > 30 * 60 * 1000) rooms.delete(code);
    }
  }
}, 5 * 60 * 1000);

server.listen(PORT, () => console.log('AW Tawla server listening on ' + PORT));
