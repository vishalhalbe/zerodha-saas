import express from "express";
import path from "path";
import { fileURLToPath } from "url";

const app = express();
const PORT = process.env.PORT || 3000;

// Fix for __dirname in ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Serve static files from public folder
app.use(express.static(path.join(__dirname, "public")));

// Handle root route - send index.html
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// Your other routes (e.g. /api/exchange) go here
app.post("/api/exchange", async (req, res) => {
  res.json({ status: "success", data: { access_token: "demo" } });
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
