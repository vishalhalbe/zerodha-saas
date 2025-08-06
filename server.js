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
app.use(session({
  secret: 'supersecret',
  resave: false,
  saveUninitialized: true
}));
app.use(express.static(path.join(__dirname, 'public')));

// --- Step 1: User enters API Key and Secret ---
app.post('/register', (req, res) => {
  const { apiKey, apiSecret } = req.body;
  if (!apiKey || !apiSecret) return res.status(400).send('Missing API key or secret');

  req.session.apiKey = apiKey;
  req.session.apiSecret = apiSecret;

  req.session.save(() => {
    const redirectUrl = `https://kite.zerodha.com/connect/login?v=3&api_key=${apiKey}`;
    res.redirect(redirectUrl);
  });
});

// --- Step 2: Zerodha redirects to this route with request_token ---
app.get('/api/exchange', async (req, res) => {
  const { request_token } = req.query;
  const { apiKey, apiSecret } = req.session;

  if (!request_token || !apiKey || !apiSecret) {
    return res.status(400).send("Missing session or request_token");
  }

  try {
    const kc = new KiteConnect({ api_key: apiKey });
    const response = await kc.generateSession(request_token, apiSecret);
    req.session.accessToken = response.access_token;
    req.session.save(() => {
      res.redirect('/');
    });
  } catch (err) {
    console.error("❌ Error generating session:", err);
    res.status(500).send("Failed to generate session");
  }
});

// --- WebSocket: Send live arbitrage data ---
io.on('connection', (socket) => {
  console.log("🟢 Client connected");

  let ticker = null;

  socket.on('start-stream', ({ apiKey, accessToken }) => {
    if (!apiKey || !accessToken) return;

    ticker = new KiteTicker({
      api_key: apiKey,
      access_token: accessToken
    });

    const spotTokens = {
      NIFTY_SPOT: 256265,
      BANKNIFTY_SPOT: 260105
    };

    const futureTokens = {
      NIFTY_FUT: 13809946,     // Replace with latest weekly/monthly future token
      BANKNIFTY_FUT: 13811458  // Replace with latest weekly/monthly future token
    };

    const allTokens = Object.values({ ...spotTokens, ...futureTokens });

    const latestPrices = {};

    ticker.connect();

    ticker.on("connect", () => {
      console.log("✅ Ticker connected");
      ticker.subscribe(allTokens);
      ticker.setMode(ticker.modeFull, allTokens);
    });

    ticker.on("ticks", (ticks) => {
      ticks.forEach(t => {
        if (Object.values(spotTokens).includes(t.instrument_token)) {
          if (t.instrument_token === spotTokens.NIFTY_SPOT) latestPrices.NIFTY_SPOT = t.last_price;
          if (t.instrument_token === spotTokens.BANKNIFTY_SPOT) latestPrices.BANKNIFTY_SPOT = t.last_price;
        }
        if (Object.values(futureTokens).includes(t.instrument_token)) {
          if (t.instrument_token === futureTokens.NIFTY_FUT) latestPrices.NIFTY_FUT = t.last_price;
          if (t.instrument_token === futureTokens.BANKNIFTY_FUT) latestPrices.BANKNIFTY_FUT = t.last_price;
        }
      });

      if (latestPrices.NIFTY_SPOT && latestPrices.NIFTY_FUT) {
        latestPrices.NIFTY_ARB = (latestPrices.NIFTY_FUT - latestPrices.NIFTY_SPOT).toFixed(2);
      }
      if (latestPrices.BANKNIFTY_SPOT && latestPrices.BANKNIFTY_FUT) {
        latestPrices.BANKNIFTY_ARB = (latestPrices.BANKNIFTY_FUT - latestPrices.BANKNIFTY_SPOT).toFixed(2);
      }

      socket.emit("arbitrage", latestPrices);
    });

    ticker.on("error", (err) => {
      console.error("❌ Ticker error:", err);
    });

    ticker.on("disconnect", () => {
      console.log("🔌 Ticker disconnected");
    });
  });

  socket.on('disconnect', () => {
    console.log("🔴 Client disconnected");
    if (ticker) ticker.disconnect();
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🚀 Server running at http://localhost:${PORT}`);
});
