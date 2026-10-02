import React, { useState, useEffect, useRef } from 'react';
import io from 'socket.io-client';
import { getRtcConfig, tuneSdp, fmtTime, STATUS_LABEL } from './common';

const BACKEND_URL = typeof import.meta.env.VITE_BACKEND_URL !== 'undefined' ? import.meta.env.VITE_BACKEND_URL : 'http://localhost:3999';

export default function App() {
  const [socket, setSocket] = useState(null);
  const [clientId] = useState(() => {
    let id = localStorage.getItem('radioClientId');
    if (!id) { id = crypto.randomUUID ? crypto.randomUUID() : String(Math.random()).slice(2); localStorage.setItem('radioClientId', id); }
    return id;
  });

  const [info, setInfo] = useState({});
  const [live, setLive] = useState(false);
  const [listenerCount, setListenerCount] = useState(0);
  const [library, setLibrary] = useState([]);
  const [nowPlaying, setNowPlaying] = useState(null);
  const [myRequests, setMyRequests] = useState([]);

  const [search, setSearch] = useState('');

  const [tuned, setTuned] = useState(false);
  const [connText, setConnText] = useState('Not connected');
  const [volume, setVolume] = useState(90);

  const playerRef = useRef(null);
  const pcRef = useRef(null);


  // State for modal / payment
  const [modalOpen, setModalOpen] = useState(false);
  const [step, setStep] = useState(1);
  const [activeReq, setActiveReq] = useState(null);
  const [pickedSong, setPickedSong] = useState(null);
  const [customTitle, setCustomTitle] = useState('');
  const [reqName, setReqName] = useState(() => localStorage.getItem('radioName') || '');
  const [reqMsg, setReqMsg] = useState('');
  const [reqArtistName, setReqArtistName] = useState('');
  const [err1, setErr1] = useState('');
  const [err2, setErr2] = useState('');
  const [payRes, setPayRes] = useState(null);
  const [utr, setUtr] = useState('');
  const [doneText, setDoneText] = useState('');

  // Socket setup
  useEffect(() => {
    const s = io(BACKEND_URL);
    setSocket(s);

    s.on('connect', () => s.emit('listener:join', { clientId }));
    s.on('station:state', (state) => {
      setInfo(state.info || {});
      setLive(state.live);
      setLibrary(state.library || []);
      setNowPlaying(state.nowPlaying);
      setListenerCount(state.listeners);

      setMyRequests(state.myRequests || []);
      if (tuned) s.emit('listener:tunein');
    });
    s.on('station:info', setInfo);
    s.on('station:status', ({ live: l }) => setLive(l));
    s.on('station:library', setLibrary);
    s.on('station:nowPlaying', setNowPlaying);
    s.on('station:listeners', setListenerCount);
    s.on('request:update', (r) => {
      setMyRequests(prev => {
        const arr = prev.filter(x => x.id !== r.id);
        return [...arr, r];
      });
    });


    return () => s.disconnect();
  }, [clientId, tuned]);

  // WebRTC Signal handler
  useEffect(() => {
    if (!socket || !tuned) return;
    const handleSignal = async ({ from, data }) => {
      try {
        if (data.sdp && data.sdp.type === 'offer') {
          if (pcRef.current) pcRef.current.close();
          const pc = new RTCPeerConnection(await getRtcConfig());
          pcRef.current = pc;
          pc.ontrack = (e) => {
            if (playerRef.current) {
              playerRef.current.srcObject = e.streams[0] || new MediaStream([e.track]);
              playerRef.current.play().then(() => setConnText('Listening live')).catch(() => setConnText('Tap “Stop listening” then “Tune in” to start audio'));
            }
          };
          pc.onicecandidate = (e) => { if (e.candidate) socket.emit('signal', { to: from, data: { candidate: e.candidate } }); };
          pc.onconnectionstatechange = () => {
            const state = pc.connectionState;
            if (state === 'connected') setConnText('Listening live');
            else if (state === 'disconnected') setConnText('Signal weak — reconnecting…');
            else if (state === 'failed') { setConnText('Connection failed. Try tuning in again.'); pc.close(); pcRef.current = null; }
          };
          await pc.setRemoteDescription(data.sdp);
          const answer = await pc.createAnswer();
          answer.sdp = tuneSdp(answer.sdp);
          await pc.setLocalDescription(answer);
          socket.emit('signal', { to: from, data: { sdp: pc.localDescription } });
        } else if (data.candidate && pcRef.current) {
          await pcRef.current.addIceCandidate(data.candidate);
        }
      } catch (e) { console.warn('Signal error', e); }
    };
    socket.on('signal', handleSignal);
    return () => socket.off('signal', handleSignal);
  }, [socket, tuned]);



  const toggleTune = () => {
    if (!tuned) {
      setTuned(true);
      if (playerRef.current) {
        playerRef.current.muted = false;
        playerRef.current.play().catch(()=>{});
      }
      socket.emit('listener:tunein');
      setConnText(live ? 'Connecting…' : 'Waiting for the host to go live…');
    } else {
      setTuned(false);
      socket.emit('listener:tuneout');
      if (pcRef.current) { pcRef.current.close(); pcRef.current = null; }
      if (playerRef.current) playerRef.current.srcObject = null;
      setConnText('Not connected');
    }
  };

  const handleVolume = (e) => {
    const val = e.target.value;
    setVolume(val);
    if (playerRef.current) playerRef.current.volume = val / 100;
  };

  const openRequest = (song) => {
    setPickedSong(song);
    setCustomTitle('');
    setReqArtistName('');
    setErr1('');
    setStep(1);
    setModalOpen(true);
  };
  
  const openManualRequest = (q) => {
    setPickedSong(null);
    setCustomTitle(q);
    setReqArtistName('');
    setErr1('');
    setStep(1);
    setModalOpen(true);
  };

  const submitRequest = () => {
    const song = pickedSong ? pickedSong.title : customTitle.trim();
    if (!song) return setErr1('Please enter a song name.');
    
    const artist = pickedSong ? pickedSong.artist : reqArtistName.trim();
    const name = reqName.trim();
    
    if (name) localStorage.setItem('radioName', name);

    const message = `🎵 Song Request\nSong: ${song}\nArtist: ${artist || "Not specified"}\nFrom: ${name || "Anonymous"}\nSent from My Radio`;
    
    const number = window.RADIO_WHATSAPP_NUMBER || "91XXXXXXXXXX";
    const url = `https://wa.me/${number}?text=${encodeURIComponent(message)}`;
    window.open(url, '_blank');
    
    setModalOpen(false);
  };

  const submitUtr = () => {
    if (!activeReq) return;
    socket.emit('request:submitUtr', { id: activeReq.id, utr }, (res) => {
      if (!res?.ok) return setErr2(res?.error || 'Couldn’t submit.');
      setDoneText('The host will check your payment and play your song. You’ll see the status change here.');
      setStep(3);
    });
  };



  const filteredLibrary = library.filter(s => !search || (s.title + ' ' + s.artist).toLowerCase().includes(search.toLowerCase()));
  const sortedRequests = [...myRequests].filter(r => r.status !== 'cancelled').sort((a, b) => b.createdAt - a.createdAt);

  return (
    <main className="wrap">
      <header className="top">
        <div className="brand">
          <span className={`lamp ${live ? 'on' : ''}`} aria-hidden="true"></span>
          <div>
            <h1>{info.stationName || 'Radio'}</h1>
            <p className="muted">{info.tagline}</p>
          </div>
        </div>
        <div className="row">
          <span className="status-text">{live ? 'On air' : 'Off air'}</span>
          <span className="pill"><span>{listenerCount}</span>&nbsp;listening</span>
        </div>
      </header>

      <section className={`dial ${live && tuned ? 'on' : ''}`}>
        {!live ? (
          <>
            <p className="dial-title">Waiting for the show</p>
            <p className="dial-sub">The host isn’t on air right now.</p>
          </>
        ) : nowPlaying ? (
          <>
            <p className="dial-title">{nowPlaying.title}</p>
            <p className="dial-sub">{nowPlaying.artist} {nowPlaying.by ? ` · Requested by ${nowPlaying.by}` : ''}</p>
            {nowPlaying.message && <p className="dedication">“{nowPlaying.message}”</p>}
          </>
        ) : (
          <>
            <p className="dial-title">On air</p>
            <p className="dial-sub">The host is talking</p>
          </>
        )}
      </section>

      <div className="grid listen" style={{ marginTop: 16 }}>
        <div className="col">
          <section className="panel">
            <button className={`btn-big ${!tuned ? 'btn-amber' : ''}`} onClick={toggleTune}>
              {!tuned ? '▶ Tune in' : '■ Stop listening'}
            </button>
            <div className="row spread" style={{ marginTop: 14 }}>
              <span className="row"><span className={`eq ${tuned && live ? 'on' : ''}`}><i></i><i></i><i></i><i></i></span><span className="muted small">{connText}</span></span>
            </div>
            <div className="slider" style={{ marginTop: 12 }}>
              <span>Volume</span>
              <input type="range" min="0" max="100" value={volume} onChange={handleVolume} />
              <span>{volume}</span>
            </div>
            <audio ref={playerRef} playsInline autoPlay></audio>
          </section>

          <section className="panel">
            <div className="panel-head">
              <h2>Request a song</h2>
              <span className="pill">{info.price > 0 ? `₹${info.price} per request` : 'Requests are free'}</span>
            </div>
            <input type="search" placeholder="Search the host’s library" value={search} onChange={e => setSearch(e.target.value)} style={{ marginBottom: 10 }} />
            <ul className="list">
              {search && (
                <li className="track" style={{ background: 'rgba(255,193,7,.1)', border: '1px dashed var(--amber)', marginBottom: 10 }}>
                  <span aria-hidden="true">🔍</span>
                  <div className="t"><b>Request "{search}"</b><span>Not in the host’s library</span></div>
                  <button className="btn-sm btn-amber" disabled={!info.paymentsReady} onClick={() => openManualRequest(search)}>Request</button>
                </li>
              )}
              {filteredLibrary.map(s => (
                <li key={s.id} className="track">
                  <span aria-hidden="true">·</span>
                  <div className="t"><b>{s.title}</b><span>{s.artist || 'Unknown artist'}</span></div>
                  <button className="btn-sm btn-amber" disabled={!info.paymentsReady} onClick={() => openRequest(s)}>Request</button>
                </li>
              ))}
              {filteredLibrary.length === 0 && !search && <li className="empty">The host hasn’t loaded any songs yet.</li>}
            </ul>
          </section>
        </div>

        <div className="col">
          <section className="panel">
            <div className="panel-head"><h2>Your requests</h2></div>
            <ul className="list">
              {sortedRequests.map(r => (
                <li key={r.id} className={`req ${r.status}`}>
                  <div className="row spread"><b>{r.songTitle}</b><span className={`tag ${r.status}`}>{STATUS_LABEL[r.status]}</span></div>
                  {r.message && <div className="msg">“{r.message}”</div>}
                  <div className="row small muted">
                    {r.amount > 0 ? `₹${r.amount}` : 'Free'} <span>{r.ref}</span>
                    {r.status === 'awaiting_payment' && <button className="btn-sm" onClick={() => { setActiveReq(r); setStep(2); setModalOpen(true); }}>Finish payment</button>}
                  </div>
                </li>
              ))}
              {sortedRequests.length === 0 && <li className="empty">Pick a song from the library to get it played.</li>}
            </ul>
          </section>


        </div>
      </div>

      {modalOpen && (
        <div className="modal" role="dialog" onClick={e => { if(e.target.className === 'modal') setModalOpen(false) }}>
          <div className="sheet">
            {step === 1 && (
              <div className="form-grid">
                <h2>Request this song</h2>
                <div className="form-grid">
                  <label>Song Name * <input type="text" value={pickedSong ? pickedSong.title : customTitle} onChange={e => setCustomTitle(e.target.value)} disabled={!!pickedSong} /></label>
                  <label>Artist Name <input type="text" value={pickedSong ? (pickedSong.artist || '') : reqArtistName} onChange={e => setReqArtistName(e.target.value)} disabled={!!pickedSong} /></label>
                </div>
                <label>Listener Name <input type="text" value={reqName} onChange={e => setReqName(e.target.value)} /></label>
                {err1 && <p className="error">{err1}</p>}
                <div className="row">
                  <button className="btn-amber" style={{ flex: 1 }} onClick={submitRequest}>Send on WhatsApp</button>
                  <button className="btn-ghost" onClick={() => setModalOpen(false)}>Cancel</button>
                </div>
              </div>
            )}
            {step === 2 && payRes && (
              <div className="form-grid">
                <h2>Pay with UPI</h2>
                <p className="amount">₹{payRes.request.amount}</p>
                <p className="muted small" style={{ textAlign: 'center' }}>to <b>{payRes.payee}</b> · <span>{payRes.upiId}</span></p>
                <a className="btn btn-amber btn-big" href={payRes.link}>Open UPI app</a>
                {payRes.qr && <img className="qr" src={payRes.qr} alt="UPI QR code" />}
                <label>After paying, enter the 12-digit UTR
                  <input type="text" inputMode="numeric" maxLength="12" value={utr} onChange={e => setUtr(e.target.value.replace(/\D/g, ''))} />
                </label>
                {err2 && <p className="error">{err2}</p>}
                <div className="row">
                  <button className="btn-amber" style={{ flex: 1 }} onClick={submitUtr}>Submit payment</button>
                  <button className="btn-ghost" onClick={() => setModalOpen(false)}>Cancel request</button>
                </div>
              </div>
            )}
            {step === 3 && (
              <div className="form-grid" style={{ textAlign: 'center' }}>
                <h2>Request sent</h2>
                <p className="muted">{doneText}</p>
                <button className="btn-amber" onClick={() => setModalOpen(false)}>Back to the show</button>
              </div>
            )}
          </div>
        </div>
      )}
    </main>
  );
}
