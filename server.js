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

// --- App Setup ---
const app = express();
const server = http.createServer(app);
const io = new SocketIO(server, {
  cors: { origin: "*", methods: ["GET", "POST"] }
});

// --- Middleware ---
app.use(cors());
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());
app.use(session({
  secret: 'supersecret',
  resave: false,
  saveUninitialized: true
}));
app.use(express.static(path.join(__dirname, 'public')));

// --- Step 1: Register API Key & Secret ---
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

// --- Step 2: OAuth Token Exchange via AJAX (called by frontend) ---
app.post('/api/exchange', async (req, res) => {
  const { api_key, api_secret, request_token } = req.body;
  if (!api_key || !api_secret || !request_token) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  const kc = new KiteConnect({ api_key });

  try {
    const session = await kc.generateSession(request_token, api_secret);
    return res.json({ access_token: session.access_token });
  } catch (error) {
    console.error('❌ Token exchange failed:', error);
    return res.status(500).json({ error: 'Token exchange failed' });
  }
});

// --- WebSocket Logic ---
io.on('connection', (socket) => {
  console.log('🟢 WebSocket connected:', socket.id);

  let ticker = null;

  socket.on('start-stream', ({ api_key, access_token }) => {
    if (!api_key || !access_token) return;

    ticker = new KiteTicker({ api_key, access_token });

    ticker.connect();

    ticker.on('connect', () => {
      console.log('✅ Ticker connected:', socket.id);
      const tokens = [256265, 260105]; // NIFTY, BANKNIFTY
      ticker.subscribe(tokens);
      ticker.setMode(ticker.modeFull, tokens);
    });

    ticker.on('ticks', (ticks) => {
      socket.emit('tick', ticks);
    });

    ticker.on('error', (err) => {
      console.error('❌ Ticker error:', err);
    });

    ticker.on('disconnect', () => {
      console.log('🔌 Ticker disconnected:', socket.id);
    });
  });

  socket.on('disconnect', () => {
    console.log('🔴 WebSocket disconnected:', socket.id);
    if (ticker) ticker.disconnect();
  });
});

// --- Start Server ---
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🌍 Server running at http://localhost:${PORT}`);
});
