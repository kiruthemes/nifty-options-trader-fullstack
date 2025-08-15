// server/src/index.ts
import "dotenv/config";
import express from "express";
import cors from "cors";
import morgan from "morgan";
import http from "http";
import { Server as IOServer } from "socket.io";

import authRouter from "./routes/auth";
import strategiesRouter from "./routes/strategies";
import tradeRouter from "./routes/trade";
import marketRouter from "./routes/market";
import brokersRouter from "./routes/brokers";
import legsRouter from "./routes/legs";
import providersRouter from "./routes/providers";
import { auth } from "./middleware/auth";
import { startSyntheticTicks, getLatestTick } from "./ticks";
import { wireTicks } from "./services/dataFeed";
import { startDailyFutCloseCapture } from "./services/dataFeed";

// ⬇️ ADD THESE
import { startDailySnapshots, snapshotAllExpiries } from "./services/dataFeed";
import { initDhanFeed, wsSubscribeChain, wsUnsubscribeChain, getLastFutPriceFromDB } from "./ws/dhanFeed";

const app = express();

const allowOrigin = process.env.ALLOW_ORIGIN || "http://localhost:5173";
app.use(cors({ origin: allowOrigin, credentials: false }));
app.use(express.json({ limit: "1mb" }));
app.use(morgan("tiny"));

app.get("/api/health", (_req, res) => res.json({ ok: true }));

// Public
app.use("/api/auth", auth);
app.use("/api/auth", authRouter);
app.set("etag", false);
// Protected (or mixed) routes
app.use("/api/strategies", auth, strategiesRouter);
app.use("/api", auth, tradeRouter);
app.use("/api/market", marketRouter);
app.use("/api/brokers", brokersRouter);
app.use("/api/legs", auth, legsRouter);
app.use("/api/providers", auth, providersRouter);

// Socket.io
const server = http.createServer(app);
const io = new IOServer(server, { cors: { origin: allowOrigin } });

initDhanFeed(io).catch(err => {
  console.warn("[DHAN-WS] init failed:", err?.message || err);
});

io.on("connection", (socket) => {
  console.log("client connected", socket.id);
  // Send last available futures price (persisted from DHAN feed) to new client if available
  try {
    getLastFutPriceFromDB().then((futTick) => {
      if (futTick) socket.emit("feed:fut", futTick);
    });
  } catch (e) {}
  // FE will emit this when user picks an expiry
  socket.on("oc:select", ({ symbol, expiry }) => {
    if (!symbol || !expiry) return;
    wsSubscribeChain(String(symbol), String(expiry));
  });
  socket.on("disconnect", () => console.log("client disconnected", socket.id));
});

// Synthetic ticks for now (wire real later)
startSyntheticTicks(io);
wireTicks(io);

// ⬇️ START DAILY SNAPSHOTS (15:20 IST by default) FOR NIFTY
startDailySnapshots("NIFTY");
startDailyFutCloseCapture("NIFTY");

// ⬇️ OPTIONAL: pre-warm the store on boot when market is closed
if (process.env.OC_PREWARM_ON_BOOT === "1") {
  snapshotAllExpiries("NIFTY").catch(() => {});
}

const PORT = Number(process.env.PORT || 4000);
server.listen(PORT, () => {
  console.log(`API listening on http://localhost:${PORT}`);
  console.log(`CORS allowOrigin = ${allowOrigin}`);
});
