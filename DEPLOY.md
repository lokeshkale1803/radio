# Put your radio on the internet (free, about 15 minutes)

When you're done you'll have two links that work from anywhere — any Wi-Fi, mobile data, any city:

- Studio: `https://your-radio.onrender.com/host.html`
- Listeners: `https://your-radio.onrender.com/listen.html`

## 1. Put the code on GitHub

1. Create a free account at github.com.
2. Click **New repository**, name it `radio-station`, keep it **Private**, click **Create repository**.
3. On the new repo page click **uploading an existing file**, drag in everything inside the `radio` folder (not `node_modules`), and click **Commit changes**.

## 2. Get a free TURN relay (needed for mobile data)

Jio, Airtel, Vi and many office networks block direct audio connections. A TURN relay fixes that.

1. Sign up at metered.ca → **TURN Server** → create an app (free plan).
2. Copy the TURN URL(s), username and password it shows. Keep this tab open.

## 3. Deploy on Render

1. Sign up at render.com with your GitHub account.
2. Click **New → Web Service**, pick your `radio-station` repo.
3. Fill in:
   - **Runtime:** Node
   - **Build command:** `npm install`
   - **Start command:** `npm start`
   - **Instance type:** Free
4. Under **Environment Variables**, add:

   | Key | Value |
   |---|---|
   | `HOST_KEY` | a long password only you know |
   | `UPI_ID` | your UPI ID, e.g. `yourname@okaxis` |
   | `PAYEE_NAME` | the name shown in the payer's UPI app |
   | `STATION_NAME` | your station's name |
   | `PRICE` | price per request in rupees, e.g. `20` |
   | `TURN_URL` | from Metered, e.g. `turn:global.relay.metered.ca:80,turn:global.relay.metered.ca:443` |
   | `TURN_USERNAME` | from Metered |
   | `TURN_CREDENTIAL` | from Metered |

5. Click **Create Web Service**. After a few minutes it shows a link like `https://radio-station-xxxx.onrender.com`.

## 4. Go live

1. On your computer open `https://<your-link>/host.html`, enter your `HOST_KEY`, allow the microphone.
2. Add songs, press Play, press **Go live**.
3. Share `https://<your-link>/listen.html` on WhatsApp, Instagram, anywhere.

## Good to know about the free plan

- **It sleeps after 15 minutes with no visitors.** Open the studio a minute before your show; the first load can take ~50 seconds. Render's $7/month plan stays awake.
- **Settings in environment variables are permanent.** Changes you make in the studio's settings box last until the server restarts or redeploys, then go back to the environment values. Request history also resets on restart. For permanent history, use a paid plan with a disk and set `DATA_DIR` to the disk's path.
- **Your songs never upload anywhere.** They stream live from your studio computer, so keep that tab open and your internet steady during the show. Each listener uses about 130 kbps of *your* upload speed.

## Other hosts

Anything that runs Node 18+ with WebSockets and HTTPS works the same way: Railway, Fly.io, Koyeb, or your own VPS (run `npm start` behind Nginx with a Let's Encrypt certificate). Set the same environment variables there.
