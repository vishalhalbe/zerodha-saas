import { KiteTicker } from "kiteconnect";
import express from "express";
import http from "http";
import { Server } from "socket.io";

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

let ticker;

io.on("connection", (socket) => {
  console.log("Client connected");

  socket.on("start-stream", ({ api_key, access_token }) => {
    if (ticker) return;

    ticker = new KiteTicker({ api_key, access_token });

    ticker.connect();
    ticker.on("connect", () => {
      console.log("WebSocket connected");
      ticker.subscribe([256265, 260105]); // NIFTY, BANKNIFTY
    });

    ticker.on("ticks", (ticks) => {
      socket.emit("tick", ticks);
    });

    ticker.on("error", (err) => {
      console.error("Ticker error", err);
    });
  });
});

server.listen(3000, () => {
  console.log("Server running on port 3000");
});
