// 🚀 Updated server.js for Spot vs Future + NSE vs BSE Arbitrage
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
    console.error('Token exchange error:', err);
    res.status(500).send('Token exchange failed');
  }
});

io.on('connection', (socket) => {
  console.log('✅ Client connected');

  socket.on('start-stream', async ({ apiKey, accessToken }) => {
    if (!apiKey || !accessToken) return;

    const kc = new KiteConnect({ api_key: apiKey });
    kc.setAccessToken(accessToken);

    // ✅ REST polling: NSE vs BSE Spot LTP
    const symbols = [
      'NSE:RELIANCE', 'BSE:RELIANCE',
      'NSE:HDFCBANK', 'BSE:HDFCBANK',
      'NSE:INFY', 'BSE:INFY'
    ];

    const restInterval = setInterval(async () => {
      try {
        const quotes = await kc.getLTP(symbols);
        const data = [
          {
            stock: 'Reliance',
            nse: quotes['NSE:RELIANCE']?.last_price || 0,
            bse: quotes['BSE:RELIANCE']?.last_price || 0
          },
          {
            stock: 'HDFC Bank',
            nse: quotes['NSE:HDFCBANK']?.last_price || 0,
            bse: quotes['BSE:HDFCBANK']?.last_price || 0
          },
          {
            stock: 'INFY',
            nse: quotes['NSE:INFY']?.last_price || 0,
            bse: quotes['BSE:INFY']?.last_price || 0
          }
        ];
        socket.emit('bse-nse-arbitrage', data);
      } catch (err) {
        console.error('BSE/NSE fetch error:', err);
      }
    }, 5000);

    // ✅ WebSocket stream for Spot + Futures prices
    const ticker = new KiteTicker({ api_key: apiKey, access_token: accessToken });

    const instruments = {
      niftySpot: 256265,
      bankniftySpot: 260105,
      niftyFut: 13585798,     // 🛠️ Update to current expiry
      bankniftyFut: 13586562  // 🛠️ Update to current expiry
    };

    ticker.connect();

    ticker.on('connected', () => {
      console.log('📡 WebSocket connected');
      ticker.subscribe(Object.values(instruments));
      ticker.setMode(ticker.modeLTP, Object.values(instruments));
    });

    ticker.on('ticks', (ticks) => {
      socket.emit('tick', ticks); // 🔁 Send to client
    });

    ticker.on('error', (err) => {
      console.error('WS error:', err);
    });

    socket.on('disconnect', () => {
      console.log('❌ Client disconnected');
      ticker.disconnect();
      clearInterval(restInterval);
    });
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
});
