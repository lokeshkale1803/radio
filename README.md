# Radio Mehfil — live radio with UPI song requests

Two apps in one server:

- **Studio** (`/host.html`) — for the station owner. Load songs from your computer, play them, talk live on the mic (music dips automatically while you speak), go on air, approve paid song requests, chat with listeners.
- **Listener** (`/listen.html`) — for everyone else. Tune in to the live show, see what's playing, search the host's library, pay by UPI to request a song with a dedication, chat.

## Run it

Requires Node.js 18+.

```bash
npm install
HOST_KEY=pick-a-secret npm start          # macOS / Linux
set HOST_KEY=pick-a-secret && npm start   # Windows (cmd)
```

Open `http://localhost:3000/host.html`, enter your key, then in **Station and payments** add your UPI ID, name and price. Add songs, press Play, press **Go live**. Share `http://<your-address>:3000/listen.html` with listeners.

## How a paid request works

1. Listener taps **Request** on a song, adds name + dedication.
2. They get a UPI link (opens GPay / PhonePe / Paytm on phones) and a QR code (for scanning from a computer), with the exact amount and a reference like `RQ3F2A1C` in the note.
3. After paying they enter the 12-digit UTR from their UPI app.
4. In the studio you check the UTR/amount in your bank or UPI app, then tap **Payment received**. Approved requests play before your normal playlist, and the listener sees the status change live.

**Important:** a plain UPI link cannot confirm payment automatically — that's why the host verifies the UTR. For automatic confirmation, plug in a payment gateway (Razorpay, Cashfree, PhonePe PG): create an order in `request:start`, and on the gateway's webhook set the request to `approved` (the `pushRequestUpdate` helper already notifies both sides).

## Putting it on the internet

See **DEPLOY.md** for step-by-step instructions (GitHub + Render, free). Settings you can set as environment variables:

| Variable | What it does |
|---|---|
| `HOST_KEY` | Password for the studio (required) |
| `UPI_ID`, `PAYEE_NAME`, `STATION_NAME`, `STATION_TAGLINE`, `PRICE` | Default station + payment settings, kept even if the server restarts |
| `TURN_URL`, `TURN_USERNAME`, `TURN_CREDENTIAL` | TURN relay so listeners on mobile data can connect (comma-separate several URLs) |
| `ICE_SERVERS` | Advanced: full JSON array of ICE servers instead of the three above |
| `DATA_DIR` | Folder for `data.json` (point it at a persistent disk if your host has one) |

## Limits to know

- Audio goes directly from the host's browser to each listener (one WebRTC connection per listener). This works well for roughly 20–40 listeners depending on the host's upload speed (~130 kbps each). For hundreds of listeners, swap the broadcast for an SFU such as LiveKit or mediasoup, or stream into Icecast.
- Keep the studio tab open and in the foreground-capable state while live; closing it ends the show.
- Config and request history are saved to `data.json` next to `server.js`.

## Files

```
server.js            signaling, station state, UPI request flow
public/host.html     studio UI          public/js/host.js     mixing + broadcast
public/listen.html   listener UI        public/js/listen.js   playback + payments
public/js/common.js  WebRTC config, shared helpers
public/style.css     shared styles
```

Keyboard: press **M** in the studio to toggle the mic.
