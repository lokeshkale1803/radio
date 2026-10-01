// Shared helpers for host + listener pages

// ICE (STUN/TURN) servers come from the server's environment variables
let rtcConfigPromise = null;
export function getRtcConfig() {
  if (!rtcConfigPromise) {
    const url = typeof import.meta.env.VITE_BACKEND_URL !== 'undefined' ? import.meta.env.VITE_BACKEND_URL : 'http://localhost:3999';
    rtcConfigPromise = fetch(url + '/api/ice').then(r => r.json()).catch(() => ({
      iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
    }));
  }
  return rtcConfigPromise;
}

// Ask Opus for stereo music quality at ~128 kbps
export function tuneSdp(sdp) {
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
}

export function fmtTime(s) {
  if (!isFinite(s) || s < 0) s = 0;
  const m = Math.floor(s / 60), sec = Math.floor(s % 60);
  return `${m}:${String(sec).padStart(2, '0')}`;
}

export const STATUS_LABEL = {
  awaiting_payment: 'Payment pending',
  pending_verification: 'Payment verification pending',
  pending: 'In the queue',
  approved: 'Verified / Up next',
  played: 'Played',
  rejected: 'Rejected',
  cancelled: 'Cancelled'
};
