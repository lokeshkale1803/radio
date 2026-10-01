(() => {
  const $ = (id) => document.getElementById(id);
  const socket = io({ autoConnect: true });

  // ---------------- State ----------------
  let hostKey = sessionStorage.getItem('hostKey') || '';
  let joined = false;
  let live = false;
  let config = {};
  let tracks = [];            // {id, title, artist, duration, url}
  let current = -1;           // index into tracks
  let currentReq = null;      // request being played
  let requests = new Map();   // id -> request
  let reqFilter = 'open';
  const peers = new Map();    // listenerSocketId -> RTCPeerConnection

  // ---------------- Audio engine ----------------
  // music <audio> ─► musicGain ─┬─► master ─► broadcast stream (WebRTC)
  // microphone   ─► micGain  ──┘      └─► analyser (level meter)
  // musicGain ─► speakers (so the host hears the music, not their own mic)
  const music = new Audio();
  music.preload = 'auto';
  let ctx, musicGain, micGain, master, dest, analyser, micStream = null, micOn = false;

  function ensureAudio() {
    if (!ctx) {
      ctx = new (window.AudioContext || window.webkitAudioContext)({ latencyHint: 'playback' });
      const src = ctx.createMediaElementSource(music);
      musicGain = ctx.createGain();
      micGain = ctx.createGain(); micGain.gain.value = 0;
      master = ctx.createGain();
      dest = ctx.createMediaStreamDestination();
      analyser = ctx.createAnalyser(); analyser.fftSize = 512;
      src.connect(musicGain);
      musicGain.connect(master);
      musicGain.connect(ctx.destination);
      micGain.connect(master);
      master.connect(dest);
      master.connect(analyser);
      applyGains();
      meterLoop();
    }
    if (ctx.state === 'suspended') ctx.resume();
  }

  function applyGains() {
    if (!ctx) return;
    const mv = $('musicVol').value / 100;
    const kv = $('micVol').value / 100;
    const duck = $('duck').checked && micOn ? 0.25 : 1;
    musicGain.gain.setTargetAtTime(mv * duck, ctx.currentTime, 0.12);
    micGain.gain.setTargetAtTime(micOn ? kv : 0, ctx.currentTime, 0.05);
  }

  function meterLoop() {
    const buf = new Uint8Array(analyser.fftSize);
    const tick = () => {
      analyser.getByteTimeDomainData(buf);
      let peak = 0;
      for (let i = 0; i < buf.length; i++) peak = Math.max(peak, Math.abs(buf[i] - 128));
      $('vu').style.width = Math.min(100, (peak / 128) * 130) + '%';
      requestAnimationFrame(tick);
    };
    tick();
  }

  async function toggleMic() {
    ensureAudio();
    if (!micStream) {
      try {
        micStream = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
        });
        ctx.createMediaStreamSource(micStream).connect(micGain);
      } catch (e) {
        toast('Microphone blocked. Allow mic access in your browser’s site settings.', 4000);
        return;
      }
    }
    micOn = !micOn;
    const b = $('micBtn');
    b.classList.toggle('on', micOn);
    b.setAttribute('aria-pressed', micOn);
    b.textContent = micOn ? '🔴 You’re talking — tap to mute' : '🎙 Mic off — tap to talk';
    applyGains();
  }

  // ---------------- Library ----------------
  function hashId(str) {
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193); }
    return 's' + (h >>> 0).toString(16);
  }
  function parseName(fileName) {
    const base = fileName.replace(/\.[^.]+$/, '').replace(/_/g, ' ').trim();
    const parts = base.split(/\s+-\s+/);
    return parts.length >= 2 ? { artist: parts[0], title: parts.slice(1).join(' - ') } : { artist: '', title: base };
  }

  let libTimer;
  function sendLibrary() {
    clearTimeout(libTimer);
    libTimer = setTimeout(() => {
      socket.emit('host:library', tracks.map(({ id, title, artist, duration }) => ({ id, title, artist, duration })));
    }, 250);
  }

  $('fileInput').addEventListener('change', (e) => {
    ensureAudio();
    const files = [...e.target.files];
    for (const f of files) {
      const id = hashId(f.name + ':' + f.size);
      if (tracks.some(t => t.id === id)) continue;
      const { artist, title } = parseName(f.name);
      const t = { id, title, artist, duration: 0, url: URL.createObjectURL(f) };
      tracks.push(t);
      const probe = new Audio();
      probe.preload = 'metadata';
      probe.src = t.url;
      probe.onloadedmetadata = () => { t.duration = probe.duration || 0; renderLibrary(); sendLibrary(); };
    }
    e.target.value = '';
    renderLibrary();
    sendLibrary();
    if (files.length) toast(`${files.length} song${files.length > 1 ? 's' : ''} added`);
  });

  function renderLibrary() {
    const ul = $('library');
    ul.replaceChildren();
    $('libCount').textContent = tracks.length ? `(${tracks.length})` : '';
    if (!tracks.length) { ul.append(el('li', { class: 'empty' }, 'Your library is empty. Add MP3, M4A, WAV or OGG files to start.')); return; }
    tracks.forEach((t, i) => {
      ul.append(el('li', { class: 'track' + (i === current ? ' playing' : '') },
        el('button', { class: 'btn-sm btn-ghost', 'aria-label': `Play ${t.title}`, onclick: () => playIndex(i) }, i === current && !music.paused ? '♪' : '▶'),
        el('div', { class: 't' }, el('b', {}, t.title), el('span', {}, t.artist || 'Unknown artist')),
        el('div', { class: 'row' },
          el('span', { class: 'n small' }, t.duration ? fmtTime(t.duration) : ''),
          el('button', { class: 'btn-sm btn-ghost', 'aria-label': `Remove ${t.title}`, onclick: () => removeTrack(i) }, '✕'))
      ));
    });
  }

  function removeTrack(i) {
    if (i === current) { music.pause(); music.removeAttribute('src'); current = -1; currentReq = null; publishNowPlaying(); }
    URL.revokeObjectURL(tracks[i].url);
    tracks.splice(i, 1);
    if (current > i) current--;
    renderLibrary(); sendLibrary(); updateDeck();
  }

  // ---------------- Playback ----------------
  async function playIndex(i, req = null) {
    if (i < 0 || i >= tracks.length) return;
    ensureAudio();
    current = i;
    currentReq = req;
    music.src = tracks[i].url;
    try { await music.play(); } catch (e) { toast('Couldn’t play this file. Try a different format.'); return; }
    if (req) socket.emit('request:played', { id: req.id });
    renderLibrary(); updateDeck(); publishNowPlaying();
  }

  function nextApprovedRequest() {
    return [...requests.values()]
      .filter(r => r.status === 'approved' && tracks.some(t => t.id === r.songId))
      .sort((a, b) => a.createdAt - b.createdAt)[0];
  }

  function playNext() {
    const r = nextApprovedRequest();
    if (r) return playIndex(tracks.findIndex(t => t.id === r.songId), r);
    if (!tracks.length) return;
    playIndex((current + 1) % tracks.length);
  }

  function togglePlay() {
    ensureAudio();
    if (current < 0) return tracks.length ? playNext() : toast('Add songs to your library first.');
    if (music.paused) music.play(); else music.pause();
  }

  music.addEventListener('ended', () => { if ($('autoNext').checked) playNext(); else { updateDeck(); publishNowPlaying(); } });
  music.addEventListener('play', () => { updateDeck(); renderLibrary(); publishNowPlaying(); });
  music.addEventListener('pause', () => { updateDeck(); renderLibrary(); publishNowPlaying(); });
  music.addEventListener('seeked', publishNowPlaying);

  let dragging = false;
  $('seek').addEventListener('input', () => { dragging = true; });
  $('seek').addEventListener('change', () => {
    if (music.duration) music.currentTime = ($('seek').value / 1000) * music.duration;
    dragging = false;
  });
  music.addEventListener('timeupdate', () => {
    if (!dragging && music.duration) $('seek').value = (music.currentTime / music.duration) * 1000;
    dial.setProgress(music.currentTime, music.duration || 0);
  });

  const dial = new Dial($('dial'));
  function updateDeck() {
    const t = tracks[current];
    $('playBtn').textContent = !music.paused && t ? '⏸ Pause' : '▶ Play';
    if (!t) { dial.setTrack('Nothing playing', 'Add songs to your library, then press play'); dial.setProgress(0, 0); return; }
    const sub = [t.artist, currentReq ? `Requested by ${currentReq.name}` : ''].filter(Boolean).join('  ·  ');
    dial.setTrack(t.title, sub, currentReq?.message ? `“${currentReq.message}”` : '');
  }

  function publishNowPlaying() {
    const t = tracks[current];
    if (!t) return socket.emit('host:nowPlaying', null);
    socket.emit('host:nowPlaying', {
      title: t.title, artist: t.artist, duration: music.duration || t.duration,
      position: music.currentTime, paused: music.paused,
      by: currentReq?.name || '', message: currentReq?.message || ''
    });
  }
  setInterval(() => { if (!music.paused) publishNowPlaying(); }, 8000);

  // ---------------- Broadcast (WebRTC, one connection per listener) ----------------
  async function createPeer(id) {
    if (!dest) return;
    closePeer(id);
    const cfg = await getRtcConfig();
    closePeer(id);
    const pc = new RTCPeerConnection(cfg);
    peers.set(id, pc);
    dest.stream.getAudioTracks().forEach(tr => pc.addTrack(tr, dest.stream));
    pc.onicecandidate = (e) => { if (e.candidate) socket.emit('signal', { to: id, data: { candidate: e.candidate } }); };
    pc.onconnectionstatechange = () => {
      if (['failed', 'closed'].includes(pc.connectionState)) closePeer(id);
    };
    try {
      const offer = await pc.createOffer();
      offer.sdp = tuneSdp(offer.sdp);
      await pc.setLocalDescription(offer);
      socket.emit('signal', { to: id, data: { sdp: pc.localDescription } });
    } catch (e) { console.error('Offer failed', e); closePeer(id); }
  }
  function closePeer(id) {
    const pc = peers.get(id);
    if (pc) { try { pc.close(); } catch {} peers.delete(id); }
  }
  async function setBitrate(pc) {
    for (const s of pc.getSenders()) {
      try {
        const p = s.getParameters();
        p.encodings = p.encodings?.length ? p.encodings : [{}];
        p.encodings[0].maxBitrate = 128000;
        await s.setParameters(p);
      } catch {}
    }
  }

  socket.on('signal', async ({ from, data }) => {
    const pc = peers.get(from);
    if (!pc) return;
    try {
      if (data.sdp) { await pc.setRemoteDescription(data.sdp); setBitrate(pc); }
      else if (data.candidate) await pc.addIceCandidate(data.candidate);
    } catch (e) { console.warn('Signal error', e); }
  });
  socket.on('listener:new', ({ id }) => { if (live) createPeer(id); });
  socket.on('listeners:waiting', (ids) => { if (live) ids.forEach(createPeer); });
  socket.on('listener:left', ({ id }) => closePeer(id));
  socket.on('station:listeners', (n) => { $('listenerCount').textContent = n; });

  function setLive(on) {
    if (on) ensureAudio();
    live = on;
    if (!on) [...peers.keys()].forEach(closePeer);
    socket.emit('host:live', on);
    $('liveBtn').textContent = on ? 'End show' : 'Go live';
    $('liveBtn').classList.toggle('on', on);
    $('lamp').classList.toggle('on', on);
    $('liveText').textContent = on ? 'On air' : 'Off air';
    dial.setOn(on);
    if (on) publishNowPlaying();
  }
  $('liveBtn').addEventListener('click', () => {
    if (live && !confirm('End the show? Listeners will be disconnected.')) return;
    setLive(!live);
  });
  window.addEventListener('beforeunload', (e) => { if (live) { e.preventDefault(); e.returnValue = ''; } });

  // ---------------- Requests ----------------
  const OPEN = ['pending_verification', 'pending', 'approved'];
  function renderRequests() {
    const ul = $('requests');
    ul.replaceChildren();
    const all = [...requests.values()].sort((a, b) => b.createdAt - a.createdAt);
    const list = reqFilter === 'open' ? all.filter(r => OPEN.includes(r.status)).reverse() : all;
    const waiting = all.filter(r => ['pending_verification', 'pending'].includes(r.status)).length;
    const earned = all.filter(r => ['approved', 'played'].includes(r.status)).reduce((s, r) => s + (r.amount || 0), 0);
    $('reqSummary').textContent = `${waiting} to check · ₹${earned} approved this session`;
    if (!list.length) { ul.append(el('li', { class: 'empty' }, reqFilter === 'open' ? 'No open requests. They’ll appear here as listeners pay.' : 'No requests yet.')); return; }

    for (const r of list) {
      const inLib = tracks.some(t => t.id === r.songId);
      const actions = el('div', { class: 'row' });
      if (['pending_verification', 'pending'].includes(r.status)) {
        actions.append(
          el('button', { class: 'btn-sm btn-amber', onclick: () => socket.emit('request:verify', { id: r.id }) }, r.status === 'pending' ? 'Accept' : 'Payment received / Verify'),
          el('button', { class: 'btn-sm btn-ghost', onclick: () => confirm('Reject this request?') && socket.emit('request:reject', { id: r.id }) }, 'Reject'));
      } else if (r.status === 'approved') {
        actions.append(
          el('button', { class: 'btn-sm btn-amber', disabled: !inLib, onclick: () => playIndex(tracks.findIndex(t => t.id === r.songId), r) }, 'Play now'),
          el('button', { class: 'btn-sm btn-ghost', onclick: () => socket.emit('request:played', { id: r.id }) }, 'Mark played'));
      }
      const missingText = r.status === 'approved' && !inLib ? ' (Song not in library – add/find song manually)' : (!inLib ? ' (not in current library)' : '');
      
      ul.append(el('li', { class: 'req ' + r.status },
        el('div', { class: 'row spread' }, el('span', { class: 'who' }, r.name), el('span', { class: 'tag ' + r.status }, STATUS_LABEL[r.status] || r.status)),
        el('div', {}, '♪ ', r.songTitle, el('span', { class: 'small muted' }, inLib ? '' : missingText)),
        r.message ? el('div', { class: 'msg' }, `“${r.message}”`) : null,
        el('div', { class: 'row small muted' },
          r.amount > 0 ? el('span', {}, `₹${r.amount}`) : el('span', {}, 'Free'),
          r.utr ? el('span', {}, 'UTR ', el('span', { class: 'utr' }, r.utr)) : null,
          el('span', {}, r.ref),
          el('span', {}, new Date(r.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }))),
        actions.childElementCount ? actions : null
      ));
    }
  }
  document.querySelectorAll('[data-filter]').forEach(b => b.addEventListener('click', () => {
    reqFilter = b.dataset.filter;
    document.querySelectorAll('[data-filter]').forEach(x => {
      const on = x === b; x.setAttribute('aria-pressed', on); x.classList.toggle('btn-ghost', !on);
    });
    renderRequests();
  }));

  let lastAlert = 0;
  socket.on('request:update', (r) => {
    const isNew = !requests.has(r.id) || requests.get(r.id).status !== r.status;
    requests.set(r.id, r);
    renderRequests();
    if (isNew && ['pending_verification', 'pending'].includes(r.status) && Date.now() - lastAlert > 1500) {
      lastAlert = Date.now();
      toast(`New request from ${r.name}: ${r.songTitle}`);
    }
  });

  // ---------------- Chat ----------------
  function addChat(m) {
    const log = $('chatLog');
    const stick = log.scrollTop + log.clientHeight >= log.scrollHeight - 30;
    log.append(el('div', { class: 'chat-msg' + (m.host ? ' host' : '') }, el('b', {}, m.name), m.text));
    while (log.children.length > 80) log.firstChild.remove();
    if (stick) log.scrollTop = log.scrollHeight;
  }
  socket.on('chat:msg', addChat);
  $('chatForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const text = $('chatText').value.trim();
    if (!text) return;
    socket.emit('chat:send', { text });
    $('chatText').value = '';
  });

  // ---------------- Settings ----------------
  function fillConfig(c) {
    config = c;
    $('cfgName').value = c.stationName || '';
    $('cfgTag').value = c.tagline || '';
    $('cfgUpi').value = c.upiId || '';
    $('cfgPayee').value = c.payeeName || '';
    $('cfgPrice').value = c.price ?? 0;
    $('stationTitle').textContent = c.stationName || 'Studio';
    document.title = `Studio · ${c.stationName || 'Radio'}`;
  }
  $('cfgForm').addEventListener('submit', (e) => {
    e.preventDefault();
    $('cfgErr').classList.add('hidden');
    socket.emit('host:config', {
      stationName: $('cfgName').value, tagline: $('cfgTag').value,
      upiId: $('cfgUpi').value.trim(), payeeName: $('cfgPayee').value, price: $('cfgPrice').value
    }, (res) => {
      if (!res?.ok) { $('cfgErr').textContent = res?.error || 'Couldn’t save.'; $('cfgErr').classList.remove('hidden'); return; }
      fillConfig(res.config);
      toast('Settings saved');
    });
  });

  // ---------------- Login / connection ----------------
  function join(key, fromForm) {
    socket.emit('host:join', { key }, (res) => {
      if (!res?.ok) {
        sessionStorage.removeItem('hostKey');
        $('studio').classList.add('hidden'); $('login').classList.remove('hidden');
        if (fromForm) { $('loginErr').textContent = res?.error || 'Couldn’t sign in.'; $('loginErr').classList.remove('hidden'); }
        return;
      }
      hostKey = key; sessionStorage.setItem('hostKey', key);
      $('login').classList.add('hidden'); $('studio').classList.remove('hidden');
      fillConfig(res.config);
      requests = new Map(res.requests.map(r => [r.id, r]));
      renderRequests();
      $('listenerCount').textContent = res.listeners;
      if (!joined) res.chat.forEach(addChat);
      joined = true;
      sendLibrary();
      // after a reconnect, resume the broadcast automatically
      if (live) { [...peers.keys()].forEach(closePeer); socket.emit('host:live', true); publishNowPlaying(); }
      if (!config.upiId && config.price > 0) toast('Add your UPI ID in settings so listeners can pay.', 4000);
    });
  }
  $('loginForm').addEventListener('submit', (e) => { e.preventDefault(); join($('hostKey').value, true); });
  socket.on('connect', () => { if (hostKey) join(hostKey, false); });
  socket.on('disconnect', () => { if (live) toast('Connection lost — reconnecting…', 3000); });
  socket.on('host:replaced', () => {
    live = false; [...peers.keys()].forEach(closePeer); music.pause();
    alert('The studio was opened in another tab or device. This tab is now off air.');
    location.reload();
  });

  // ---------------- Controls wiring ----------------
  $('playBtn').addEventListener('click', togglePlay);
  $('nextBtn').addEventListener('click', playNext);
  $('prevBtn').addEventListener('click', () => {
    if (music.currentTime > 4) music.currentTime = 0;
    else if (tracks.length) playIndex((current - 1 + tracks.length) % tracks.length);
  });
  $('micBtn').addEventListener('click', toggleMic);
  for (const id of ['musicVol', 'micVol']) {
    $(id).addEventListener('input', () => { $(id + 'V').textContent = $(id).value; applyGains(); });
  }
  $('duck').addEventListener('change', applyGains);
  // "M" key = mic toggle when not typing
  document.addEventListener('keydown', (e) => {
    if (e.code === 'KeyM' && !['INPUT', 'TEXTAREA'].includes(document.activeElement.tagName) && joined) { e.preventDefault(); toggleMic(); }
  });

  renderLibrary();
  renderRequests();
})();
