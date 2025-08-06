const express = require('express');
const path = require('path');
const http = require('http');
const { KiteConnect, KiteTicker } = require('kiteconnect');
const socketIo = require('socket.io');
const bodyParser = require('body-parser');
const cors = require('cors');

// --- App Setup ---
const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

// --- Middleware ---
app.use(cors());
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, 'public')));

// --- WebSocket Client Handling ---
io.on('connection', (socket) => {
  console.log('🟢 Client connected:', socket.id);

  let ticker = null;

  socket.on('start-stream', ({ api_key, access_token }) => {
    console.log('🚀 Starting stream for:', socket.id);

    ticker = new KiteTicker({ api_key, access_token });

    ticker.connect();

    ticker.on('connect', () => {
      console.log('✅ Ticker connected:', socket.id);
      const tokens = [256265, 260105]; // NIFTY 50 & BANKNIFTY
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
    console.log('🔴 Client disconnected:', socket.id);
    if (ticker) ticker.disconnect();
  });
});

// --- Route (optional health check) ---
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public/index.html'));
});

// --- Start Server ---
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🌐 Server running on http://localhost:${PORT}`);
});
