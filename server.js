// server.js — start streams even when client doesn't send creds; add logs & guards
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

let globalSession = { apiKey: null, apiSecret: null, accessToken: null };

app.post('/register', (req, res) => {
  const { apiKey, apiSecret } = req.body || {};
  if (!apiKey || !apiSecret) return res.status(400).send('Missing API key/secret');
  req.session.apiKey = apiKey;
  req.session.apiSecret = apiSecret;
  globalSession.apiKey = apiKey;
  globalSession.apiSecret = apiSecret;
  req.session.save(() => {
    const redirect = `https://kite.zerodha.com/connect/login?v=3&api_key=${apiKey}`;
    res.redirect(redirect);
  });
});

app.get('/api/exchange', async (req, res) => {
  const { request_token } = req.query;
  const apiKey    = req.session.apiKey    || globalSession.apiKey;
  const apiSecret = req.session.apiSecret || globalSession.apiSecret;
  if (!request_token || !apiKey || !apiSecret) {
    return res.status(400).send('Missing session or request_token');
  }
  try {
    const kc = new KiteConnect({ api_key: apiKey });
    const response = await kc.generateSession(request_token, apiSecret);
    req.session.accessToken = response.access_token;
    globalSession.accessToken = response.access_token;
    res.redirect('/');
  } catch (err) {
    console.error('❌ Access token error:', err?.message || err);
    res.status(500).send('Token exchange failed');
  }
});

io.on('connection', (socket) => {
  console.log('🟢 Client connected:', socket.id);
  let ticker = null;
  let ltpInterval = null;

  socket.on('start-stream', async (payload = {}) => {
    const apiKey      = payload.apiKey      || globalSession.apiKey;
    const accessToken = payload.accessToken || globalSession.accessToken;
    if (!apiKey || !accessToken) {
      socket.emit('status', { level: 'error', message: 'Missing apiKey/accessToken on server' });
      console.warn('⚠️ Missing creds. apiKey?', !!apiKey, 'token?', !!accessToken);
      return;
    }
    socket.emit('status', { level: 'info', message: 'Starting streams…' });

    const kc = new KiteConnect({ api_key: apiKey });
    kc.setAccessToken(accessToken);

    // Resolve nearest monthly futures
    let niftyFutToken = null, bankniftyFutToken = null;
    try {
      const instruments = await kc.getInstruments();
      const nearestFut = (name) => {
        const futs = instruments.filter(i => i.name === name && i.segment === 'NFO-FUT');
        if (!futs.length) return null;
        futs.sort((a, b) => new Date(a.expiry) - new Date(b.expiry));
        return futs[0]?.instrument_token || null;
      };
      niftyFutToken = nearestFut('NIFTY');
      bankniftyFutToken = nearestFut('BANKNIFTY');
    } catch (e) {
      console.error('❌ getInstruments failed:', e?.message || e);
      socket.emit('status', { level: 'error', message: 'Failed to fetch instruments' });
    }

    // Start ticker
    try {
      const tokens = [256265, 260105].concat([niftyFutToken, bankniftyFutToken].filter(Boolean));
      ticker = new KiteTicker({ api_key: apiKey, access_token: accessToken });
      ticker.connect();
      ticker.on('connect', () => {
        console.log('✅ Ticker connected:', tokens);
        socket.emit('status', { level: 'info', message: 'Ticker connected' });
        if (tokens.length) ticker.subscribe(tokens);
      });
      ticker.on('ticks', (ticks) => socket.emit('tick', ticks));
      ticker.on('error', (err) => {
        console.error('❌ Ticker error:', err?.message || err);
        socket.emit('status', { level: 'error', message: 'Ticker error' });
      });
    } catch (err) {
      console.error('❌ Ticker setup failed:', err?.message || err);
      socket.emit('status', { level: 'error', message: 'Ticker setup failed' });
    }

    // Poll NSE/BSE LTP
    try {
      const symbols = [
        'NSE:RELIANCE', 'BSE:RELIANCE',
        'NSE:HDFCBANK', 'BSE:HDFCBANK',
        'NSE:INFY', 'BSE:INFY'
      ];
      ltpInterval = setInterval(async () => {
        try {
          const quotes = await kc.getLTP(symbols);
          socket.emit('nsebse', {
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
          });
        } catch (err) {
          console.error('❌ LTP fetch error:', err?.message || err);
        }
      }, 5000);
    } catch (e) {
      console.error('❌ LTP setup failed:', e?.message || e);
    }
  });

  socket.on('disconnect', () => {
    if (ltpInterval) clearInterval(ltpInterval);
    if (ticker && ticker.connected) ticker.disconnect();
    console.log('🔴 Client disconnected:', socket.id);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
});
