import "dotenv/config";
import express from "express";
import cors from "cors";
import morgan from "morgan";
import http from "http";
import { Server as IOServer } from "socket.io";

import authRouter from "./routes/auth";
import strategiesRouter from "./routes/strategies";
import tradeRouter from "./routes/trade";
import { auth } from "./middleware/auth";
import { startSyntheticTicks } from "./ticks";
import legsRouter from "./routes/legs"; 

const app = express();

const allowOrigin = process.env.ALLOW_ORIGIN || "http://localhost:5173";
app.use(cors({ origin: allowOrigin, credentials: false }));
app.use(express.json({ limit: "1mb" }));
app.use(morgan("tiny"));

app.get("/api/health", (_req, res) => res.json({ ok: true }));

// Public
app.use("/api/auth", authRouter);

// Protected
app.use("/api/strategies", auth, strategiesRouter);
app.use("/api/legs", auth, legsRouter);
app.use("/api", auth, tradeRouter);

const server = http.createServer(app);
const io = new IOServer(server, { cors: { origin: allowOrigin } });

io.on("connection", (socket) => {
  console.log("client connected", socket.id);
  socket.on("disconnect", () => console.log("client disconnected", socket.id));
});

// Synthetic ticks for now
startSyntheticTicks(io);

const PORT = Number(process.env.PORT || 4000);
server.listen(PORT, () => {
  console.log(`API listening on http://localhost:${PORT}`);
  console.log(`CORS allowOrigin = ${allowOrigin}`);
});
