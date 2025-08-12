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
const io = new SocketIO(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] }
});

/* ---------- Core middleware ---------- */
app.use(cors());
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

// Render sits behind a proxy/HTTPS
app.set('trust proxy', 1);

const sessionMiddleware = session({
  secret: process.env.SESSION_SECRET || 'supersecret',
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: 'lax',                                // works with OAuth redirect
    secure: process.env.NODE_ENV === 'production',  // true on Render, false locally
    maxAge: 7 * 24 * 60 * 60 * 1000                 // 7 days
  }
});

app.use(sessionMiddleware);

// Make the same session available to Socket.IO
io.engine.use((req, res, next) => sessionMiddleware(req, {}, next));

app.use(express.static(path.join(__dirname, 'public')));

/* ---------- Routes ---------- */

// Register API key/secret and start OAuth
app.post('/register', (req, res) => {
  const { apiKey, apiSecret } = req.body;
  if (!apiKey || !apiSecret) return res.status(400).send('Missing API key/secret');

  req.session.apiKey = apiKey;
  req.session.apiSecret = apiSecret;

  // Save before redirect so cookie is set
  req.session.save(() => {
    const redirect = `https://kite.zerodha.com/connect/login?v=3&api_key=${apiKey}`;
    res.redirect(redirect);
  });
});

// OAuth callback -> exchange request_token for access_token
app.get('/api/exchange', async (req, res) => {
  const { request_token } = req.query;
  const { apiKey, apiSecret } = req.session || {};

  if (!request_token || !apiKey || !apiSecret) {
    return res.status(400).send('Missing session');
  }

  const kc = new KiteConnect({ api_key: apiKey });
  try {
    const resp = await kc.generateSession(request_token, apiSecret);
    req.session.accessToken = resp.access_token;

    // Save the updated session and send user to dashboard
    req.session.save(() => res.redirect('/'));
  } catch (err) {
    console.error('❌ Access token error:', err);
    res.status(500).send('Token exchange failed');
  }
});

// Simple status to verify session from the browser
app.get('/status', (req, res) => {
  res.json({
    hasApiKey: Boolean(req.session?.apiKey),
    hasAccessToken: Boolean(req.session?.accessToken)
  });
});

/* ---------- Socket.IO ---------- */

io.on('connection', (socket) => {
  console.log('✅ Client connected');

  socket.on('start-stream', async () => {
    const sess = socket.request.session;
    const apiKey = sess?.apiKey;
    const accessToken = sess?.accessToken;

    if (!apiKey || !accessToken) {
      socket.emit('status', { level: 'error', message: 'Missing apiKey/accessToken on server' });
      return;
    }

    socket.emit('status', { step: 'session-ok' });

    const kc = new KiteConnect({ api_key: apiKey });
    kc.setAccessToken(accessToken);

    // Resolve nearest-month futures dynamically
    let niftyFutToken = null;
    let bankniftyFutToken = null;

    try {
      const instruments = await kc.getInstruments();
      const nearest = (name) => {
        const futs = instruments.filter(i => i.name === name && i.segment === 'NFO-FUT');
        if (!futs.length) return null;
        futs.sort((a, b) => new Date(a.expiry) - new Date(b.expiry));
        return futs[0]?.instrument_token ?? null;
      };
      niftyFutToken = nearest('NIFTY');
      bankniftyFutToken = nearest('BANKNIFTY');
      console.log('✅ FUT tokens:', { niftyFutToken, bankniftyFutToken });
    } catch (e) {
      console.error('❌ getInstruments failed:', e);
    }

    // Subscribe only to valid tokens
    const tokens = [256265, 260105, niftyFutToken, bankniftyFutToken].filter(Boolean);

    const ticker = new KiteTicker({ api_key: apiKey, access_token: accessToken });

    ticker.on('connect', () => {
      console.log('✅ Ticker connected');
      if (tokens.length) {
        ticker.subscribe(tokens);
        // LTP is enough for this dashboard; switch to FULL if you need depth
        ticker.setMode(ticker.modeLTP, tokens);
        socket.emit('status', { step: 'ticker-subscribed', tokens });
      } else {
        socket.emit('status', { level: 'warn', message: 'No valid tokens to subscribe' });
      }
    });

    ticker.on('ticks', (ticks) => {
      socket.emit('tick', ticks);
    });

    ticker.on('error', (err) => {
      console.error('❌ Ticker error:', err);
      socket.emit('status', { level: 'error', message: 'Ticker error' });
    });

    ticker.connect();

    // Poll LTP for BSE/NSE equity arbitrage
    const ltpSymbols = [
      'NSE:RELIANCE', 'BSE:RELIANCE',
      'NSE:HDFCBANK', 'BSE:HDFCBANK',
      'NSE:INFY',     'BSE:INFY'
    ];

    const ltpInterval = setInterval(async () => {
      try {
        const quotes = await kc.getLTP(ltpSymbols);
        socket.emit('bse-nse-arbitrage', {
          reliance: {
            nse: quotes['NSE:RELIANCE']?.last_price ?? 0,
            bse: quotes['BSE:RELIANCE']?.last_price ?? 0
          },
          hdfc: {
            nse: quotes['NSE:HDFCBANK']?.last_price ?? 0,
            bse: quotes['BSE:HDFCBANK']?.last_price ?? 0
          },
          infy: {
            nse: quotes['NSE:INFY']?.last_price ?? 0,
            bse: quotes['BSE:INFY']?.last_price ?? 0
          }
        });
      } catch (err) {
        console.error('❌ LTP fetch error:', err);
        socket.emit('status', { level: 'error', message: 'LTP fetch error' });
      }
    }, 5000);

    socket.on('disconnect', () => {
      clearInterval(ltpInterval);
      try { ticker.disconnect(); } catch {}
      console.log('🔌 Client disconnected');
    });
  });
});

/* ---------- Start ---------- */

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
});
