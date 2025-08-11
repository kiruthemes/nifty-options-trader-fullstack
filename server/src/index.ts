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
import { startSyntheticTicks } from "./ticks";
import { wireTicks } from "./services/dataFeed";

const app = express();

const allowOrigin = process.env.ALLOW_ORIGIN || "http://localhost:5173";
app.use(cors({ origin: allowOrigin, credentials: false }));
app.use(express.json({ limit: "1mb" }));
app.use(morgan("tiny"));

app.get("/api/health", (_req, res) => res.json({ ok: true }));

// Public
app.use("/api/auth", auth);
app.use("/api/auth", authRouter); // if your auth router expects auth for refresh, otherwise remove previous line

// Protected (or mixed) routes
app.use("/api/strategies", auth, strategiesRouter);
app.use("/api", auth, tradeRouter);
app.use("/api/market", marketRouter); // public GETs inside; secure writes inside the router
app.use("/api/brokers", brokersRouter); // each route applies `auth` internally
app.use("/api/legs", auth, legsRouter);

// IMPORTANT: mount providers ONLY ONCE with auth
app.use("/api/providers", auth, providersRouter);

// Socket.io
const server = http.createServer(app);
const io = new IOServer(server, { cors: { origin: allowOrigin } });

io.on("connection", (socket) => {
  console.log("client connected", socket.id);
  socket.on("disconnect", () => console.log("client disconnected", socket.id));
});

// Synthetic ticks for now (wire real later)
startSyntheticTicks(io);
wireTicks(io);

const PORT = Number(process.env.PORT || 4000);
server.listen(PORT, () => {
  console.log(`API listening on http://localhost:${PORT}`);
  console.log(`CORS allowOrigin = ${allowOrigin}`);
});
