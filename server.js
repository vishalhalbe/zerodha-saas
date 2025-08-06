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

// Step 1: Register API key & secret
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

// Step 2: Callback from Zerodha with request_token
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

// WebSocket
io.on('connection', (socket) => {
  console.log('🟢 Client connected');

  let ticker = null;

  socket.on('start-stream', ({ apiKey, accessToken }) => {
    if (!apiKey || !accessToken) return;

    ticker = new KiteTicker({ api_key: apiKey, access_token: accessToken });
    ticker.connect();

    ticker.on('connect', () => {
      const tokens = [256265, 260105]; // NIFTY, BANKNIFTY
      ticker.subscribe(tokens);
      ticker.setMode(ticker.modeFull, tokens);
    });

    ticker.on('ticks', (ticks) => {
      socket.emit('tick', ticks);
    });

    ticker.on('error', (err) => {
      console.error('Ticker error:', err);
    });

    ticker.on('disconnect', () => {
      console.log('Ticker disconnected');
    });
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
