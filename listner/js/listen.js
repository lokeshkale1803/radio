(() => {
  const $ = (id) => document.getElementById(id);
  const socket = io(BACKEND_URL, {
    transports: ["websocket", "polling"]
  });

  let clientId = localStorage.getItem('radioClientId');
  if (!clientId) { clientId = (crypto.randomUUID ? crypto.randomUUID() : String(Math.random()).slice(2)); localStorage.setItem('radioClientId', clientId); }

  let info = {}, live = false, tuned = false, pc = null, hostId = null;
  let library = [], nowPlaying = null;
  const myRequests = new Map();
  let activeReq = null, pickedSong = null;
  const dial = new Dial($('dial'));
  const player = $('player');

  // ---------------- Station state ----------------
  socket.on('connect', () => socket.emit('listener:join', { clientId }));
  socket.on('station:state', (s) => {
    applyInfo(s.info);
    setLive(s.live);
    library = s.library; renderLibrary();
    setNowPlaying(s.nowPlaying);
    $('listenerCount').textContent = s.listeners;
    $('chatLog').replaceChildren(); s.chat.forEach(addChat);
    s.myRequests.forEach(r => myRequests.set(r.id, r)); renderMine();
    if (tuned) socket.emit('listener:tunein'); // re-register after reconnect
  });
  socket.on('station:info', applyInfo);
  socket.on('station:status', ({ live: l }) => setLive(l));
  socket.on('station:library', (l) => { library = l; renderLibrary(); });
  socket.on('station:nowPlaying', setNowPlaying);
  socket.on('station:listeners', (n) => { $('listenerCount').textContent = n; });

  function applyInfo(i) {
    info = i || {};
    $('stationName').textContent = info.stationName || 'Radio';
    $('tagline').textContent = info.tagline || '';
    document.title = info.stationName || 'Radio';
    $('priceTag').textContent = info.price > 0 ? `₹${info.price} per request` : 'Requests are free';
    renderLibrary();
  }

  function setLive(l) {
    live = l;
    $('lamp').classList.toggle('on', live);
    $('liveText').textContent = live ? 'On air' : 'Off air';
    dial.setOn(live && tuned);
    if (!live) {
      closePc();
      if (tuned) setConn('Waiting for the host to go live…');
      dial.setTrack('Waiting for the show', 'The host isn’t on air right now. Keep this page open — you’ll hear it as soon as they go live.');
      dial.setProgress(0, 0);
    } else if (tuned) setConn('Connecting…');
    if (live) setNowPlaying(nowPlaying);
  }

  function setNowPlaying(np) {
    nowPlaying = np;
    if (!live) return;
    if (!np) { dial.setTrack('On air', 'The host is talking'); dial.setProgress(0, 0); return; }
    const sub = [np.artist, np.by ? `Requested by ${np.by}` : ''].filter(Boolean).join('  ·  ');
    dial.setTrack(np.title, sub, np.message ? `“${np.message}”` : '');
    tickProgress();
  }
  function tickProgress() {
    if (!live || !nowPlaying) return;
    const pos = nowPlaying.paused ? nowPlaying.position : nowPlaying.position + (Date.now() - nowPlaying.at) / 1000;
    dial.setProgress(Math.min(pos, nowPlaying.duration || pos), nowPlaying.duration);
  }
  setInterval(tickProgress, 1000);

  // ---------------- Listening (WebRTC) ----------------
  function setConn(text, playing = false) {
    $('connText').textContent = text;
    $('eq').classList.toggle('on', playing);
  }
  function closePc() {
    if (pc) { try { pc.close(); } catch {} pc = null; }
    $('eq').classList.remove('on');
  }

  $('tuneBtn').addEventListener('click', () => {
    if (!tuned) {
      tuned = true;
      player.muted = false;
      player.play().catch(() => {}); // unlock audio on iOS/Android with this tap
      socket.emit('listener:tunein');
      $('tuneBtn').textContent = '■ Stop listening';
      $('tuneBtn').classList.remove('btn-amber');
      setConn(live ? 'Connecting…' : 'Waiting for the host to go live…');
      dial.setOn(live);
    } else {
      tuned = false;
      socket.emit('listener:tuneout');
      closePc();
      player.srcObject = null;
      $('tuneBtn').textContent = '▶ Tune in';
      $('tuneBtn').classList.add('btn-amber');
      setConn('Not connected');
      dial.setOn(false);
    }
  });

  socket.on('signal', async ({ from, data }) => {
    if (!tuned) return;
    try {
      if (data.sdp && data.sdp.type === 'offer') {
        closePc();
        hostId = from;
        pc = new RTCPeerConnection(await getRtcConfig());
        pc.ontrack = (e) => {
          player.srcObject = e.streams[0] || new MediaStream([e.track]);
          player.play().then(() => setConn('Listening live', true)).catch(() => setConn('Tap “Stop listening” then “Tune in” to start audio'));
        };
        pc.onicecandidate = (e) => { if (e.candidate) socket.emit('signal', { to: hostId, data: { candidate: e.candidate } }); };
        pc.onconnectionstatechange = () => {
          const s = pc?.connectionState;
          if (s === 'connected') setConn('Listening live', true);
          else if (s === 'disconnected') setConn('Signal weak — reconnecting…');
          else if (s === 'failed') { setConn('Connection failed. Try tuning in again.'); closePc(); }
        };
        await pc.setRemoteDescription(data.sdp);
        const answer = await pc.createAnswer();
        answer.sdp = tuneSdp(answer.sdp);
        await pc.setLocalDescription(answer);
        socket.emit('signal', { to: hostId, data: { sdp: pc.localDescription } });
      } else if (data.candidate && pc && from === hostId) {
        await pc.addIceCandidate(data.candidate);
      }
    } catch (e) { console.warn('Signal error', e); }
  });

  $('vol').addEventListener('input', () => { player.volume = $('vol').value / 100; $('volV').textContent = $('vol').value; });
  player.volume = 0.9;

  // ---------------- Library + requests ----------------
  $('search').addEventListener('input', renderLibrary);
  function renderLibrary() {
    const ul = $('library');
    ul.replaceChildren();
    const qRaw = $('search').value.trim();
    const q = qRaw.toLowerCase();
    const list = library.filter(s => !q || (s.title + ' ' + s.artist).toLowerCase().includes(q));
    
    if (qRaw) {
      ul.append(el('li', { class: 'track', style: 'background: rgba(255,193,7,.1); border: 1px dashed var(--amber); margin-bottom: 10px;' },
        el('span', { 'aria-hidden': 'true' }, '🔍'),
        el('div', { class: 't' }, el('b', {}, `Request "${qRaw}"`), el('span', {}, 'Not in the host’s library')),
        el('button', { class: 'btn-sm btn-amber', disabled: !info.paymentsReady, onclick: () => openManualRequest(qRaw) }, 'Request')
      ));
    }

    if (!library.length && !q) { ul.append(el('li', { class: 'empty' }, 'The host hasn’t loaded any songs yet. Check back once the show starts.')); return; }
    if (!list.length && !q) { ul.append(el('li', { class: 'empty' }, `No songs match “${qRaw}”.`)); return; }
    for (const s of list.slice(0, 300)) {
      const isNow = nowPlaying && nowPlaying.title === s.title && nowPlaying.artist === s.artist;
      ul.append(el('li', { class: 'track' + (isNow ? ' playing' : '') },
        el('span', { 'aria-hidden': 'true' }, isNow ? '♪' : '·'),
        el('div', { class: 't' }, el('b', {}, s.title), el('span', {}, s.artist || 'Unknown artist')),
        el('button', { class: 'btn-sm btn-amber', disabled: !info.paymentsReady, onclick: () => openRequest(s) }, 'Request')
      ));
    }
  }

  function renderMine() {
    const ul = $('myRequests');
    ul.replaceChildren();
    const list = [...myRequests.values()].filter(r => r.status !== 'cancelled').sort((a, b) => b.createdAt - a.createdAt);
    if (!list.length) { ul.append(el('li', { class: 'empty' }, info.price > 0 ? `Pick a song from the library and pay ₹${info.price} by UPI to get it played.` : 'Pick a song from the library to get it played.')); return; }
    for (const r of list) {
      ul.append(el('li', { class: 'req ' + r.status },
        el('div', { class: 'row spread' }, el('b', {}, r.songTitle), el('span', { class: 'tag ' + r.status }, STATUS_LABEL[r.status])),
        r.message ? el('div', { class: 'msg' }, `“${r.message}”`) : null,
        el('div', { class: 'row small muted' }, r.amount > 0 ? `₹${r.amount}` : 'Free', el('span', {}, r.ref),
          r.status === 'awaiting_payment' ? el('button', { class: 'btn-sm', onclick: () => resumePayment(r) }, 'Finish payment') : null)
      ));
    }
  }

  socket.on('request:update', (r) => {
    const prev = myRequests.get(r.id);
    myRequests.set(r.id, r);
    renderMine();
    if (prev && prev.status !== r.status) {
      if (r.status === 'approved') toast('Payment verified — your song is up next!');
      if (r.status === 'played') toast(`Now playing your request: ${r.songTitle}`);
      if (r.status === 'rejected') toast('The host couldn’t accept your request. Contact them about the payment if you paid.', 4500);
    }
  });

  // ----- Request sheet -----
  const modal = $('modal');
  function showStep(n) { [1, 2, 3].forEach(i => $('step' + i).classList.toggle('hidden', i !== n)); }
  function openModal() { modal.classList.remove('hidden'); }
  function closeModal() { modal.classList.add('hidden'); activeReq = null; }
  modal.addEventListener('click', (e) => { if (e.target === modal || e.target.hasAttribute('data-close')) closeModal(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !modal.classList.contains('hidden')) closeModal(); });

  function openRequest(song) {
    pickedSong = song;
    $('reqCustomFields').classList.add('hidden');
    $('sheetSong').classList.remove('hidden');
    $('sheetSong').textContent = song.artist ? `${song.title} — ${song.artist}` : song.title;
    $('reqName').value = localStorage.getItem('radioName') || '';
    $('reqMsg').value = '';
    $('err1').classList.add('hidden');
    $('startBtn').textContent = info.price > 0 ? `Continue to pay ₹${info.price}` : 'Send request';
    showStep(1); openModal();
    $('reqName').focus();
  }

  function openManualRequest(q) {
    pickedSong = null;
    $('sheetSong').classList.add('hidden');
    $('reqCustomFields').classList.remove('hidden');
    $('reqSongTitle').value = q;
    $('reqArtistName').value = '';
    $('reqName').value = localStorage.getItem('radioName') || '';
    $('reqMsg').value = '';
    $('err1').classList.add('hidden');
    $('startBtn').textContent = info.price > 0 ? `Continue to pay ₹${info.price}` : 'Send request';
    showStep(1); openModal();
    $('reqSongTitle').focus();
  }

  $('startBtn').addEventListener('click', () => {
    const name = $('reqName').value.trim();
    if (!name) { $('err1').textContent = 'Add your name so the host can give you a shout-out.'; $('err1').classList.remove('hidden'); return; }
    
    let reqData = { name, message: $('reqMsg').value };
    if (pickedSong) {
      reqData.songId = pickedSong.id;
    } else {
      reqData.customTitle = $('reqSongTitle').value.trim();
      reqData.customArtist = $('reqArtistName').value.trim();
      if (!reqData.customTitle) {
        $('err1').textContent = 'Please enter a song name.'; $('err1').classList.remove('hidden'); return;
      }
    }

    localStorage.setItem('radioName', name);
    $('startBtn').disabled = true;
    socket.emit('request:start', reqData, (res) => {
      $('startBtn').disabled = false;
      if (!res?.ok) { $('err1').textContent = res?.error || 'Couldn’t create the request.'; $('err1').classList.remove('hidden'); return; }
      myRequests.set(res.request.id, res.request); renderMine();
      if (res.free) { $('doneText').textContent = 'Your request is in the host’s queue.'; showStep(3); return; }
      showPayment(res);
    });
  });

  const payCache = new Map(); // request id -> payment details (so "Finish payment" works)
  function showPayment(res) {
    activeReq = res.request;
    payCache.set(res.request.id, res);
    $('payAmount').textContent = `₹${res.request.amount}`;
    $('payPayee').textContent = res.payee;
    $('payUpi').textContent = res.upiId;
    $('payLink').href = res.link;
    if (res.qr) { $('payQr').src = res.qr; $('payQr').classList.remove('hidden'); } else $('payQr').classList.add('hidden');
    $('utr').value = '';
    $('err2').classList.add('hidden');
    showStep(2); openModal();
  }
  function resumePayment(r) {
    const cached = payCache.get(r.id);
    if (cached) return showPayment(cached);
    toast('Cancel this one and request again to get a fresh payment link.');
  }

  $('utr').addEventListener('input', () => { $('utr').value = $('utr').value.replace(/\D/g, '').slice(0, 12); });
  $('utrBtn').addEventListener('click', () => {
    if (!activeReq) return;
    $('utrBtn').disabled = true;
    socket.emit('request:submitUtr', { id: activeReq.id, utr: $('utr').value }, (res) => {
      $('utrBtn').disabled = false;
      if (!res?.ok) { $('err2').textContent = res?.error || 'Couldn’t submit.'; $('err2').classList.remove('hidden'); return; }
      $('doneText').textContent = 'The host will check your payment and play your song. You’ll see the status change here.';
      showStep(3);
    });
  });
  $('cancelReq').addEventListener('click', () => {
    if (activeReq) socket.emit('request:cancel', { id: activeReq.id });
    closeModal();
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
    let name = localStorage.getItem('radioName');
    if (!name) { name = (prompt('Your name for the chat?') || '').trim().slice(0, 30); if (!name) return; localStorage.setItem('radioName', name); }
    socket.emit('chat:send', { name, text });
    $('chatText').value = '';
  });

  renderLibrary(); renderMine();
})();
