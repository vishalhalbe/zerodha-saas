import express from 'express';
import session from 'express-session';
import path from 'path';
import { fileURLToPath } from 'url';
import { KiteConnect, KiteTicker } from 'kiteconnect';
import http from 'http';
import { Server as SocketIO } from 'socket.io';
import bodyParser from 'body-parser';
import cors from 'cors';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const app = express();
const server = http.createServer(app);
const io = new SocketIO(server);

app.use(cors());
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());
app.use(session({ secret: 'supersecret', resave: false, saveUninitialized: true }));
app.use(express.static(path.join(__dirname, 'public')));

// === TOKEN MAPPING ===
const niftySpot = 256265;
const bankniftySpot = 260105;

const niftyFuture = 13250562;      // Update as needed
const bankniftyFuture = 13480450;  // Update as needed

const relianceNSE = 738561;
const relianceBSE = 738561 + 1;

const hdfcbankNSE = 341249;
const hdfcbankBSE = 341249 + 1;

const infyNSE = 408065;
const infyBSE = 408065 + 1;

const tokenList = [
  niftySpot, bankniftySpot,
  niftyFuture, bankniftyFuture,
  relianceNSE, relianceBSE,
  hdfcbankNSE, hdfcbankBSE,
  infyNSE, infyBSE
];

// === Registration ===
app.post('/register', (req, res) => {
  const { apiKey, apiSecret } = req.body;
  if (!apiKey || !apiSecret) return res.status(400).send('Missing API key/secret');
  req.session.apiKey = apiKey;
  req.session.apiSecret = apiSecret;
  req.session.save(() => {
    const redirect = `https://kite.zerodha.com/connect/login?v=3&api_key=${apiKey}`;
    res.redirect(redirect);
  });
});

// === OAuth Exchange ===
app.get('/api/exchange', async (req, res) => {
  const { request_token } = req.query;
  const { apiKey, apiSecret } = req.session;

  if (!request_token || !apiKey || !apiSecret)
    return res.status(400).send('Session missing');

  const kc = new KiteConnect({ api_key: apiKey });

  try {
    const response = await kc.generateSession(request_token, apiSecret);
    req.session.accessToken = response.access_token;
    req.session.save(() => {
      res.redirect('/');
    });
  } catch (err) {
    console.error('❌ OAuth error:', err);
    res.status(500).send('OAuth exchange failed');
  }
});

// === WebSocket ===
io.on('connection', (socket) => {
  console.log('🟢 Client connected');

  let ticker = null;
  const latestPrices = {};

  socket.on('start-stream', ({ apiKey, accessToken }) => {
    if (!apiKey || !accessToken) return;

    ticker = new KiteTicker({ api_key: apiKey, access_token: accessToken });
    ticker.connect();

    ticker.on('connect', () => {
      console.log('✅ Ticker connected');
      ticker.subscribe(tokenList);
      ticker.setMode(ticker.modeFull, tokenList);
    });

    ticker.on('ticks', (ticks) => {
      for (let tick of ticks) {
        latestPrices[tick.instrument_token] = tick.last_price;
      }

      const data = {
        nifty: {
          spot: latestPrices[niftySpot] || 0,
          future: latestPrices[niftyFuture] || 0
        },
        banknifty: {
          spot: latestPrices[bankniftySpot] || 0,
          future: latestPrices[bankniftyFuture] || 0
        },
        reliance: {
          nse: latestPrices[relianceNSE] || 0,
          bse: latestPrices[relianceBSE] || 0
        },
        hdfcbank: {
          nse: latestPrices[hdfcbankNSE] || 0,
          bse: latestPrices[hdfcbankBSE] || 0
        },
        infy: {
          nse: latestPrices[infyNSE] || 0,
          bse: latestPrices[infyBSE] || 0
        }
      };

      socket.emit("arbitrage", data);
    });

    ticker.on('error', err => console.error('❌ Ticker error:', err));
    ticker.on('disconnect', () => console.log('🔌 Ticker disconnected'));
  });

  socket.on('disconnect', () => {
    if (ticker) ticker.disconnect();
    console.log('🔴 Client disconnected');
  });
});

// === Server Start ===
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`✅ Running on http://localhost:${PORT}`);
});
