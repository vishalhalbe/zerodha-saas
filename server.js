// server.js
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

let globalSession = {};

app.post('/register', (req, res) => {
  const { apiKey, apiSecret } = req.body;
  if (!apiKey || !apiSecret) return res.status(400).send('Missing API key/secret');
  req.session.apiKey = apiKey;
  req.session.apiSecret = apiSecret;
  globalSession = { apiKey, apiSecret };
  req.session.save(() => {
    const redirect = `https://kite.zerodha.com/connect/login?v=3&api_key=${apiKey}`;
    res.redirect(redirect);
  });
});

// Check if user session has an access token
app.get('/api/session', (req, res) => {
  const loggedIn = Boolean(req.session.accessToken);
  res.json({ loggedIn });
});

app.get('/api/exchange', async (req, res) => {
  const { request_token } = req.query;
  const { apiKey, apiSecret } = req.session;
  if (!request_token || !apiKey || !apiSecret) return res.status(400).send('Missing session');

  const kc = new KiteConnect({ api_key: apiKey });
  try {
    const response = await kc.generateSession(request_token, apiSecret);
    req.session.accessToken = response.access_token;
    globalSession.accessToken = response.access_token;
    res.redirect('/');
  } catch (err) {
    console.error('Access token error:', err);
    res.status(500).send('Token exchange failed');
  }
});

io.on('connection', (socket) => {
  console.log('✅ Client connected');

  socket.on('start-stream', async () => {
    const { apiKey, accessToken } = globalSession;
    if (!apiKey || !accessToken) return;

    const kc = new KiteConnect({ api_key: apiKey });
    kc.setAccessToken(accessToken);

    const instruments = await kc.getInstruments();

    const getNearestFut = (name) => {
      const futs = instruments.filter(i => i.name === name && i.segment === 'NFO-FUT');
      const sorted = futs.sort((a, b) => new Date(a.expiry) - new Date(b.expiry));
      return sorted[0]?.instrument_token;
    };

    const niftyFutToken = getNearestFut("NIFTY");
    const bankniftyFutToken = getNearestFut("BANKNIFTY");

    console.log("✅ NIFTY FUT:", niftyFutToken, "BANKNIFTY FUT:", bankniftyFutToken);

    const tokens = [
      256265, // NIFTY Spot
      260105, // BANKNIFTY Spot
      niftyFutToken,
      bankniftyFutToken
    ];

    const ticker = new KiteTicker({ api_key: apiKey, access_token: accessToken });

    ticker.connect();
    ticker.on('connect', () => {
      console.log('✅ WebSocket connected');
      ticker.subscribe(tokens);
    });

    ticker.on('ticks', (ticks) => {
      console.log("📈 Ticks received", ticks);
      socket.emit('tick', ticks);
    });

    ticker.on('error', (err) => {
      console.error('❌ Ticker error:', err);
    });

    const ltpSymbols = [
      'NSE:RELIANCE', 'BSE:RELIANCE',
      'NSE:HDFCBANK', 'BSE:HDFCBANK',
      'NSE:INFY', 'BSE:INFY'
    ];

    const ltpInterval = setInterval(async () => {
      try {
        const quotes = await kc.getLTP(ltpSymbols);
        const data = {
          reliance: {
            nse: quotes['NSE:RELIANCE']?.last_price || 0,
            bse: quotes['BSE:RELIANCE']?.last_price || 0
          },
          hdfc: {
            nse: quotes['NSE:HDFCBANK']?.last_price || 0,
            bse: quotes['BSE:HDFCBANK']?.last_price || 0
          },
          infy: {
            nse: quotes['NSE:INFY']?.last_price || 0,
            bse: quotes['BSE:INFY']?.last_price || 0
          }
        };
        socket.emit('bse-nse-arbitrage', data);
      } catch (err) {
        console.error('❌ LTP fetch error:', err);
      }
    }, 5000);

    socket.on('disconnect', () => {
      clearInterval(ltpInterval);
      if (ticker.connected) ticker.disconnect();
      console.log('❌ Client disconnected');
    });
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
});
