// UPI Radio — signaling + station server
// Run: HOST_KEY=yourSecret node server.js

const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { Server } = require('socket.io');
const QRCode = require('qrcode');
const cors = require('cors');

const PORT = process.env.PORT || 3000;
const HOST_KEY = process.env.HOST_KEY || 'changeme';
const DATA_FILE = path.join(process.env.DATA_DIR || __dirname, 'data.json');

// STUN/TURN for listeners on mobile data / other networks.
// Set TURN_URL, TURN_USERNAME, TURN_CREDENTIAL (or a full ICE_SERVERS JSON array).
function iceServers() {
  if (process.env.ICE_SERVERS) {
    try { return JSON.parse(process.env.ICE_SERVERS); } catch { console.error('ICE_SERVERS is not valid JSON'); }
  }
  const list = [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }];
  if (process.env.TURN_URL) {
    list.push({
      urls: process.env.TURN_URL.split(',').map(u => u.trim()),
      username: process.env.TURN_USERNAME || '',
      credential: process.env.TURN_CREDENTIAL || ''
    });
  }
  return list;
}

if (HOST_KEY === 'changeme') {
  console.warn('\n⚠️  HOST_KEY is the default "changeme". Set HOST_KEY before going public.\n');
}

const app = express();
app.use(cors()); // Allow cross-origin requests for API endpoints
const server = http.createServer(app);
const io = new Server(server, { 
  maxHttpBufferSize: 1e6,
  cors: { origin: '*' } // Allow all origins for the listener frontend
});

app.use(express.static(path.join(__dirname, 'public')));
app.get('/', (_req, res) => res.redirect('/listen.html'));
app.get('/host', (_req, res) => res.redirect('/host.html'));
app.get('/api/ice', (_req, res) => res.json({ iceServers: iceServers() }));
app.get('/healthz', (_req, res) => res.send('ok'));

// ---------- Persistent config + request log ----------
let store = {
  // Env values are the defaults, so settings survive restarts on hosts without a persistent disk
  config: {
    stationName: process.env.STATION_NAME || 'Radio Mehfil',
    tagline: process.env.STATION_TAGLINE || 'Live from the studio',
    upiId: process.env.UPI_ID || '',
    payeeName: process.env.PAYEE_NAME || '',
    price: process.env.PRICE != null ? Math.max(0, Number(process.env.PRICE) || 0) : 20
  },
  requests: []
};
try {
  if (fs.existsSync(DATA_FILE)) {
    const saved = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    store.config = { ...store.config, ...(saved.config || {}) };
    store.requests = Array.isArray(saved.requests) ? saved.requests.slice(-500) : [];
  }
} catch (e) { console.error('Could not read data.json:', e.message); }

let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    fs.writeFile(DATA_FILE, JSON.stringify(store, null, 2), (err) => err && console.error('Save failed:', err.message));
  }, 300);
}

// ---------- Live (in-memory) state ----------
const state = {
  hostSocket: null,
  live: false,
  library: [],        // [{id, title, artist, duration}]
  nowPlaying: null,   // {title, artist, duration, startedAt, requestId?, by?}
  listeners: new Set() // socket ids that tuned in
};

// ---------- Helpers ----------
const clean = (v, max = 200) => String(v ?? '').replace(/[\u0000-\u001f]/g, '').trim().slice(0, max);
const UPI_RE = /^[a-zA-Z0-9.\-_]{2,256}@[a-zA-Z]{2,64}$/;
const UTR_RE = /^[0-9]{12}$/;

function publicInfo() {
  const c = store.config;
  return { stationName: c.stationName, tagline: c.tagline, payeeName: c.payeeName, price: c.price, paymentsReady: UPI_RE.test(c.upiId) || c.price <= 0 };
}
function upiLink(amount, note) {
  const c = store.config;
  const e = encodeURIComponent;
  // Keep "@" readable in the payee address: some UPI apps reject %40
  return `upi://pay?pa=${c.upiId}&pn=${e(c.payeeName || c.stationName)}&am=${amount.toFixed(2)}&cu=INR&tn=${e(note)}`;
}
function publicRequest(r) {
  return { id: r.id, ref: r.ref, songId: r.songId, songTitle: r.songTitle, name: r.name, message: r.message, amount: r.amount, status: r.status, createdAt: r.createdAt };
}
function hostRequest(r) { return { ...publicRequest(r), utr: r.utr }; }
function toHost(event, payload) { if (state.hostSocket) io.to(state.hostSocket).emit(event, payload); }
function pushRequestUpdate(r) {
  io.to('client:' + r.clientId).emit('request:update', publicRequest(r));
  toHost('request:update', hostRequest(r));
  save();
}
function broadcastCount() { io.emit('station:listeners', state.listeners.size); }
function broadcastStatus() { io.emit('station:status', { live: state.live && !!state.hostSocket, hostOnline: !!state.hostSocket }); }

// ---------- Sockets ----------
io.on('connection', (socket) => {
  socket.data.role = 'guest';

  // ===== HOST =====
  socket.on('host:join', ({ key } = {}, ack) => {
    const a = Buffer.from(String(key || ''));
    const b = Buffer.from(HOST_KEY);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      return ack && ack({ ok: false, error: 'Wrong studio key.' });
    }
    if (state.hostSocket && state.hostSocket !== socket.id) {
      io.to(state.hostSocket).emit('host:replaced');
      const old = io.sockets.sockets.get(state.hostSocket);
      if (old) old.data.role = 'guest';
    }
    socket.data.role = 'host';
    state.hostSocket = socket.id;
    state.live = false;
    broadcastStatus();
    ack && ack({
      ok: true,
      config: store.config,
      requests: store.requests.filter(r => r.status !== 'awaiting_payment').slice(-200).map(hostRequest),
      listeners: state.listeners.size
    });
  });

  const isHost = () => socket.data.role === 'host' && state.hostSocket === socket.id;

  socket.on('host:config', (cfg = {}, ack) => {
    if (!isHost()) return;
    const upiId = clean(cfg.upiId, 256);
    if (upiId && !UPI_RE.test(upiId)) return ack && ack({ ok: false, error: 'That UPI ID doesn\'t look right. It should look like name@bank.' });
    const price = Math.max(0, Math.min(100000, Math.round(Number(cfg.price) || 0)));
    store.config = {
      stationName: clean(cfg.stationName, 60) || 'My Radio',
      tagline: clean(cfg.tagline, 100),
      upiId, payeeName: clean(cfg.payeeName, 60), price
    };
    save();
    io.emit('station:info', publicInfo());
    ack && ack({ ok: true, config: store.config });
  });

  socket.on('host:library', (list) => {
    if (!isHost() || !Array.isArray(list)) return;
    state.library = list.slice(0, 2000).map(s => ({
      id: clean(s.id, 64), title: clean(s.title, 120), artist: clean(s.artist, 120), duration: Number(s.duration) || 0
    })).filter(s => s.id && s.title);
    io.emit('station:library', state.library);
  });

  socket.on('host:nowPlaying', (np) => {
    if (!isHost()) return;
    state.nowPlaying = np ? {
      title: clean(np.title, 120), artist: clean(np.artist, 120), duration: Number(np.duration) || 0,
      position: Number(np.position) || 0, paused: !!np.paused, at: Date.now(),
      by: clean(np.by, 40), message: clean(np.message, 140)
    } : null;
    io.emit('station:nowPlaying', state.nowPlaying);
  });

  socket.on('host:live', (on) => {
    if (!isHost()) return;
    state.live = !!on;
    broadcastStatus();
    if (state.live) socket.emit('listeners:waiting', [...state.listeners]);
  });

  socket.on('request:verify', ({ id } = {}) => {
    if (!isHost()) return;
    const r = store.requests.find(x => x.id === id);
    if (r && ['pending_verification', 'pending'].includes(r.status)) { r.status = 'approved'; pushRequestUpdate(r); }
  });
  socket.on('request:reject', ({ id } = {}) => {
    if (!isHost()) return;
    const r = store.requests.find(x => x.id === id);
    if (r && r.status !== 'played') { r.status = 'rejected'; pushRequestUpdate(r); }
  });
  socket.on('request:played', ({ id } = {}) => {
    if (!isHost()) return;
    const r = store.requests.find(x => x.id === id);
    if (r) { r.status = 'played'; pushRequestUpdate(r); }
  });

  // ===== LISTENER =====
  socket.on('listener:join', ({ clientId } = {}) => {
    const cid = clean(clientId, 64) || socket.id;
    socket.data.clientId = cid;
    socket.join('client:' + cid);
    socket.emit('station:state', {
      info: publicInfo(),
      live: state.live && !!state.hostSocket,
      nowPlaying: state.nowPlaying,
      library: state.library,
      listeners: state.listeners.size,
      myRequests: store.requests.filter(r => r.clientId === cid).slice(-20).map(publicRequest)
    });
  });

  socket.on('listener:tunein', () => {
    if (socket.data.role === 'host') return;
    socket.data.role = 'listener';
    state.listeners.add(socket.id);
    broadcastCount();
    if (state.live) toHost('listener:new', { id: socket.id });
  });

  socket.on('listener:tuneout', () => {
    if (state.listeners.delete(socket.id)) {
      toHost('listener:left', { id: socket.id });
      broadcastCount();
    }
  });

  // Step 1: listener picks a song → gets a UPI link + QR
  socket.on('request:start', async ({ songId, customTitle, customArtist, name, message } = {}, ack) => {
    if (typeof ack !== 'function') return;
    const cid = socket.data.clientId;
    if (!cid) return ack({ ok: false, error: 'Reload the page and try again.' });
    
    let finalSongId = songId;
    let songTitle = '';
    
    if (songId) {
      const song = state.library.find(s => s.id === songId);
      if (!song) return ack({ ok: false, error: 'That song is no longer in the library.' });
      songTitle = song.artist ? `${song.title} — ${song.artist}` : song.title;
    } else if (customTitle) {
      const ct = clean(customTitle, 120);
      const ca = clean(customArtist, 120);
      if (!ct) return ack({ ok: false, error: 'Song name is required.' });
      songTitle = ca ? `${ct} — ${ca}` : ct;
      finalSongId = 'custom-' + Date.now() + '-' + crypto.randomBytes(2).toString('hex');
    } else {
      return ack({ ok: false, error: 'No song specified.' });
    }

    const open = store.requests.filter(r => r.clientId === cid && r.status === 'awaiting_payment');
    if (open.length >= 3) return ack({ ok: false, error: 'Finish or cancel your open requests first.' });

    const c = store.config;
    const free = c.price <= 0;
    if (!free && !UPI_RE.test(c.upiId)) return ack({ ok: false, error: 'The host hasn\'t set up payments yet.' });

    const ref = 'RQ' + crypto.randomBytes(3).toString('hex').toUpperCase();
    const r = {
      id: crypto.randomUUID(), ref, clientId: cid, songId: finalSongId,
      songTitle: songTitle,
      name: clean(name, 40) || 'A listener', message: clean(message, 140),
      amount: c.price, status: free ? 'pending' : 'awaiting_payment', utr: '', createdAt: Date.now()
    };
    store.requests.push(r);
    if (store.requests.length > 1000) store.requests = store.requests.slice(-1000);

    if (free) { pushRequestUpdate(r); return ack({ ok: true, free: true, request: publicRequest(r) }); }

    save();
    const link = upiLink(c.price, `Song request ${ref}`);
    try {
      const qr = await QRCode.toDataURL(link, { margin: 1, width: 280, errorCorrectionLevel: 'M' });
      ack({ ok: true, free: false, request: publicRequest(r), link, qr, payee: c.payeeName || c.stationName, upiId: c.upiId });
    } catch (e) {
      ack({ ok: true, free: false, request: publicRequest(r), link, qr: null, payee: c.payeeName, upiId: c.upiId });
    }
  });

  // Step 2: listener submits the 12-digit UTR after paying
  socket.on('request:submitUtr', ({ id, utr } = {}, ack) => {
    const r = store.requests.find(x => x.id === id && x.clientId === socket.data.clientId);
    if (!r) return ack && ack({ ok: false, error: 'Request not found.' });
    const u = clean(utr, 20).replace(/\s/g, '');
    if (!UTR_RE.test(u)) return ack && ack({ ok: false, error: 'The UTR / reference number is the 12 digits shown in your UPI app after payment.' });
    if (store.requests.some(x => x.utr === u && x.id !== r.id)) return ack && ack({ ok: false, error: 'This UTR was already used for another request.' });
    r.utr = u;
    r.status = 'pending_verification';
    pushRequestUpdate(r);
    ack && ack({ ok: true });
  });

  socket.on('request:cancel', ({ id } = {}) => {
    const r = store.requests.find(x => x.id === id && x.clientId === socket.data.clientId);
    if (r && r.status === 'awaiting_payment') { r.status = 'cancelled'; pushRequestUpdate(r); }
  });

  // ===== WebRTC SIGNALING (host <-> one listener) =====
  socket.on('signal', ({ to, data } = {}) => {
    if (!to || !data) return;
    if (isHost()) {
      if (state.listeners.has(to)) io.to(to).emit('signal', { from: socket.id, data });
    } else if (state.listeners.has(socket.id) && to === state.hostSocket) {
      io.to(to).emit('signal', { from: socket.id, data });
    }
  });

  socket.on('disconnect', () => {
    if (state.hostSocket === socket.id) {
      state.hostSocket = null;
      state.live = false;
      state.nowPlaying = null;
      io.emit('station:nowPlaying', null);
      broadcastStatus();
    }
    if (state.listeners.delete(socket.id)) {
      toHost('listener:left', { id: socket.id });
      broadcastCount();
    }
  });
});

server.listen(PORT, () => {
  console.log(`📻 Radio running on http://localhost:${PORT}`);
  console.log(`   Studio (host):  http://localhost:${PORT}/host.html`);
  console.log(`   Listeners:      http://localhost:${PORT}/listen.html`);
});
