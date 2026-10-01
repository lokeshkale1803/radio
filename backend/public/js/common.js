// Shared helpers for host + listener pages

// ICE (STUN/TURN) servers come from the server's environment variables
let rtcConfigPromise = null;
window.getRtcConfig = function () {
  if (!rtcConfigPromise) {
    rtcConfigPromise = fetch('/api/ice').then(r => r.json()).catch(() => ({
      iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
    }));
  }
  return rtcConfigPromise;
};

// Ask Opus for stereo music quality at ~128 kbps
window.tuneSdp = function (sdp) {
  const m = sdp.match(/a=rtpmap:(\d+) opus\/48000\/2/i);
  if (!m) return sdp;
  const pt = m[1];
  const re = new RegExp(`a=fmtp:${pt} ([^\\r\\n]*)`);
  if (re.test(sdp)) {
    return sdp.replace(re, (line, params) => {
      const extra = ['stereo=1', 'sprop-stereo=1', 'maxaveragebitrate=128000'].filter(p => !params.includes(p.split('=')[0] + '='));
      return `a=fmtp:${pt} ${params};${extra.join(';')}`;
    });
  }
  return sdp;
};

window.fmtTime = function (s) {
  if (!isFinite(s) || s < 0) s = 0;
  const m = Math.floor(s / 60), sec = Math.floor(s % 60);
  return `${m}:${String(sec).padStart(2, '0')}`;
};

window.el = function (tag, attrs = {}, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') n.className = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else if (v !== false && v != null) n.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) if (kid != null) n.append(kid.nodeType ? kid : String(kid));
  return n;
};

window.toast = function (text, ms = 2600) {
  const t = el('div', { class: 'toast', role: 'status' }, text);
  document.body.append(t);
  setTimeout(() => t.remove(), ms);
};

window.STATUS_LABEL = {
  awaiting_payment: 'Payment pending',
  pending_verification: 'Payment verification pending',
  pending: 'In the queue',
  approved: 'Verified / Up next',
  played: 'Played',
  rejected: 'Rejected',
  cancelled: 'Cancelled'
};

// The tuning dial: needle travels 88 → 108 across the song
window.Dial = class {
  constructor(root) {
    this.root = root;
    this.title = root.querySelector('.dial-title');
    this.sub = root.querySelector('.dial-sub');
    this.needle = root.querySelector('.needle');
    this.cur = root.querySelector('[data-cur]');
    this.dur = root.querySelector('[data-dur]');
    this.ded = root.querySelector('.dedication');
  }
  setTrack(title, sub, dedication) {
    this.title.textContent = title;
    this.sub.textContent = sub || '';
    if (this.ded) {
      this.ded.textContent = dedication || '';
      this.ded.classList.toggle('hidden', !dedication);
    }
  }
  setProgress(pos, dur) {
    const pct = dur > 0 ? Math.min(100, Math.max(0, (pos / dur) * 100)) : 0;
    this.needle.style.left = `calc(${pct}% - 1px)`;
    this.cur.textContent = fmtTime(pos);
    this.dur.textContent = dur > 0 ? fmtTime(dur) : '--:--';
  }
  setOn(on) { this.root.classList.toggle('on', !!on); }
};
