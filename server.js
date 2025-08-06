// ✅ UPDATED server.js with Futures + NSE-BSE Arbitrage
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

// --- FUTURES Expiry Calculation ---
function getNextMonthlyExpiry() {
  const today = new Date();
  let month = today.getMonth();
  let year = today.getFullYear();

  function lastThursday(month, year) {
    const lastDay = new Date(year, month + 1, 0);
    let date = new Date(lastDay);
    while (date.getDay() !== 4) date.setDate(date.getDate() - 1);
    return date;
  }

  let expiry = lastThursday(month, year);
  if (expiry < today) {
    month = (month + 1) % 12;
    if (month === 0) year++;
    expiry = lastThursday(month, year);
  }
  return expiry.toISOString().split('T')[0];
}

// --- Register API Key & Secret ---
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

// --- OAuth Callback ---
app.get('/api/exchange', async (req, res) => {
  const { request_token } = req.query;
  const { apiKey, apiSecret } = req.session;
  if (!request_token || !apiKey || !apiSecret) return res.status(400).send('Session missing');

  const kc = new KiteConnect({ api_key: apiKey });
  try {
    const response = await kc.generateSession(request_token, apiSecret);
    req.session.accessToken = response.access_token;
    req.session.save(() => {
      res.redirect('/');
    });
  } catch (err) {
    console.error('❌ Access token error:', err);
    res.status(500).send('OAuth exchange failed');
  }
});

// --- WebSocket Streaming ---
io.on('connection', (socket) => {
  console.log('🟢 Client connected');
  let ticker = null;

  socket.on('start-stream', ({ apiKey, accessToken }) => {
    if (!apiKey || !accessToken) return;
    ticker = new KiteTicker({ api_key: apiKey, access_token: accessToken });
    ticker.connect();

    const indexTokens = { NIFTY: 256265, BANKNIFTY: 260105 };
    const nseBsePairs = [
      { symbol: 'RELIANCE', nse: 738561, bse: 13623042 },
      { symbol: 'HDFCBANK', nse: 341249, bse: 13460482 },
      { symbol: 'INFY', nse: 408065, bse: 13596418 },
    ];

    ticker.on('connect', () => {
      const tokens = [indexTokens.NIFTY, indexTokens.BANKNIFTY];
      nseBsePairs.forEach(pair => tokens.push(pair.nse, pair.bse));
      ticker.subscribe(tokens);
      ticker.setMode(ticker.modeLTP, tokens);
    });

    const prices = { spot: {}, bse: {}, nse: {} };

    ticker.on('ticks', (ticks) => {
      ticks.forEach(tick => {
        if (tick.instrument_token === indexTokens.NIFTY) prices.spot.NIFTY = tick.last_price;
        else if (tick.instrument_token === indexTokens.BANKNIFTY) prices.spot.BANKNIFTY = tick.last_price;

        const match = nseBsePairs.find(p => p.nse === tick.instrument_token || p.bse === tick.instrument_token);
        if (match) {
          if (tick.instrument_token === match.nse) prices.nse[match.symbol] = tick.last_price;
          if (tick.instrument_token === match.bse) prices.bse[match.symbol] = tick.last_price;
        }
      });

      const arbitrage = nseBsePairs.map(({ symbol }) => {
        const nse = prices.nse[symbol] || 0;
        const bse = prices.bse[symbol] || 0;
        const diff = bse && nse ? (bse - nse).toFixed(2) : '--';
        return { symbol, nse, bse, diff };
      });

      socket.emit('tick', {
        nifty: prices.spot.NIFTY,
        banknifty: prices.spot.BANKNIFTY,
        arbitrage,
        expiry: getNextMonthlyExpiry()
      });
    });

    ticker.on('error', (err) => console.error('❌ Ticker error:', err));
    ticker.on('disconnect', () => console.log('🔌 Ticker disconnected'));
  });

  socket.on('disconnect', () => {
    if (ticker) ticker.disconnect();
    console.log('🔴 Client disconnected');
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`✅ Running on http://localhost:${PORT}`);
});
