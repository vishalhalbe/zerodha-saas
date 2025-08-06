
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const { KiteConnect, KiteTicker } = require("kiteconnect");

const app = express();
const server = http.createServer(app);
const io = new Server(server);
app.use(express.static("public"));
app.use(express.json());

const apiKey = process.env.ZERODHA_API_KEY;
const accessToken = process.env.ZERODHA_ACCESS_TOKEN;
const ticker = new KiteTicker({ api_key: apiKey, access_token: accessToken });

ticker.connect();
ticker.on("connect", () => {
  ticker.subscribe([256265, 260105]);
  ticker.setMode(ticker.modeFull, [256265, 260105]);
});

ticker.on("ticks", ticks => {
  io.emit("ticks", ticks);
});

app.post("/api/exchange", async (req, res) => {
  try {
    const { api_key, request_token, checksum } = req.body;
    const response = await fetch("https://api.kite.trade/session/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ api_key, request_token, checksum })
    });
    const data = await response.json();
    res.status(200).json({ status: "success", data });
  } catch (e) {
    res.status(500).json({ status: "error", message: e.message });
  }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log("Server running on port " + PORT));
