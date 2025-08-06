// ✅ Updated server.js for NSE-BSE Arbitrage using Kite REST API (getLTP)
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

let globalSession = {}; // Store credentials across sessions

// Register API Key and Secret
app.post('/register', (req, res) => {
  const { apiKey, apiSecret } = req.body;
  if (!apiKey || !apiSecret) return res.status(400).send('Missing API key/secret');
  req.session.apiKey = apiKey;
  req.session.apiSecret = apiSecret;
  globalSession = { apiKey, apiSecret }; // Save globally
  req.session.save(() => {
    const redirect = `https://kite.zerodha.com/connect/login?v=3&api_key=${apiKey}`;
    res.redirect(redirect);
  });
});

// OAuth Token Exchange
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

// WebSocket & LTP Logic
io.on('connection', (socket) => {
  console.log('Client connected');

  socket.on('start-stream', async ({ apiKey, accessToken }) => {
    if (!apiKey || !accessToken) return;

    const kc = new KiteConnect({ api_key: apiKey });
    kc.setAccessToken(accessToken);

    // Start periodic LTP polling
    const symbols = [
      'NSE:RELIANCE', 'BSE:RELIANCE',
      'NSE:HDFCBANK', 'BSE:HDFCBANK',
      'NSE:INFY', 'BSE:INFY'
    ];

    const interval = setInterval(async () => {
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
        console.error('LTP fetch error:', err);
      }
    }, 5000);

    socket.on('disconnect', () => {
      clearInterval(interval);
      console.log('Client disconnected');
    });
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
