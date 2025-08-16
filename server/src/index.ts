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
import prisma from "./db";
import { startDailyFutCloseCapture } from "./services/dataFeed";

// ⬇️ ADD THESE
import { startDailySnapshots, snapshotAllExpiries } from "./services/dataFeed";
import { initDhanFeed, wsSubscribeChain, wsUnsubscribeChain, getLastFutPriceFromDB } from "./ws/dhanFeed";
import path from "path";

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
    getLastFutPriceFromDB().then(async (futTick) => {
      const now = new Date();
      const utcMs = now.getTime() + now.getTimezoneOffset() * 60000;
      const ist = new Date(utcMs + 5.5 * 60 * 60000);
      const day = ist.getDay();
      const mins = ist.getHours() * 60 + ist.getMinutes();
      const open = day >= 1 && day <= 5 && mins >= 9 * 60 + 15 && mins <= 15 * 60 + 30;
      if (futTick) {
        socket.emit("feed:fut", futTick);
      } else if (!open) {
        try {
          const { loadDhanInstrumentMaps } = await import("./lib/dhanInstruments");
          const { getHistoricalLastClose } = await import("./adapters/dhan");
          const csv = process.env.DHAN_INSTRUMENTS_CSV || path.resolve(__dirname, "../data/dhan_instruments.csv");
          const maps = loadDhanInstrumentMaps(csv);
          const sym = "NIFTY";
          const futId = maps.idxFut.get(sym);
          if (futId) {
            const meta = (maps as any).bySecId?.get?.(futId) || {};
            const date = new Date(now.getTime() - now.getTimezoneOffset() * 60000)
              .toISOString()
              .slice(0, 10);
            const r = await getHistoricalLastClose({
              securityId: futId,
              exchangeSegment: "NSE_FNO" as any,
              instrument: "FUTIDX" as any,
              date,
              withOi: false,
            });
            const close = Number(r?.close);
              if (Number.isFinite(close) && close > 0) {
              const payload = {
                provider: "dhan",
                symbol: sym,
                expiry: meta?.expiry || null,
                ltp: close,
                ts: Date.now(),
              };
              await (prisma as any).lastFutTick
                .upsert({
                  where: { symbol: sym },
                  update: { expiry: payload.expiry, ltp: close, ts: payload.ts as any },
                  create: { symbol: sym, expiry: payload.expiry, ltp: close, ts: payload.ts as any },
                })
                .catch(() => {});
              socket.emit("feed:fut", payload);
                // also notify Topbar of previous close for deltas
                socket.emit("market:update", { prevCloseNifty: close });
            }
          }
        } catch {}
      }
    });
    // seed NIFTY & INDIAVIX from DB; if market closed and DB missing, fetch daily close from historic API
    (async () => {
      const want = ["NIFTY", "INDIAVIX"] as const;
      const rows = await (prisma as any).lastIndexTick
        .findMany({ where: { symbol: { in: want as any } } })
        .catch(() => []);
      const map = new Map<string, any>();
      for (const r of rows || []) map.set(String(r.symbol).toUpperCase(), r);
      const now = new Date();
      const utcMs = now.getTime() + now.getTimezoneOffset() * 60000;
      const ist = new Date(utcMs + 5.5 * 60 * 60000);
      const day = ist.getDay();
      const mins = ist.getHours() * 60 + ist.getMinutes();
      const open = day >= 1 && day <= 5 && mins >= 9 * 60 + 15 && mins <= 15 * 60 + 30;
      for (const sym of want) {
        const row = map.get(sym);
        if (row) {
          socket.emit("feed:spot", { provider: "dhan", symbol: sym, ltp: Number(row.ltp), ts: Number(row.ts) });
        } else if (!open) {
          try {
            const { loadDhanInstrumentMaps } = await import("./lib/dhanInstruments");
            const { getHistoricalLastClose } = await import("./adapters/dhan");
            const csv = process.env.DHAN_INSTRUMENTS_CSV || path.resolve(__dirname, "../data/dhan_instruments.csv");
            const maps = loadDhanInstrumentMaps(csv);
            const secId = maps.idxSpot.get(sym);
            if (secId) {
              const today = new Date();
              const date = new Date(today.getTime() - today.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
              const r = await getHistoricalLastClose({
                securityId: secId,
                exchangeSegment: "NSE_INDEX",
                instrument: "INDEX",
                date,
                withOi: false,
              });
              const close = Number(r?.close);
              if (Number.isFinite(close) && close > 0) {
                if (process.env.DEBUG_DHAN_WS === "1" || process.env.DEBUG_DATAFEED === "1") {
                  console.log(`[BOOT] Historical ${sym} close secId=${secId} date=${date} close=${close}`);
                }
                await (prisma as any).lastIndexTick
                  .upsert({ where: { symbol: sym }, update: { ltp: close, ts: Date.now() as any }, create: { symbol: sym, ltp: close, ts: Date.now() as any } })
                  .catch(() => {});
                socket.emit("feed:spot", { provider: "dhan", symbol: sym, ltp: close, ts: Date.now() });
                // also emit prevClose for deltas
                if (sym === "NIFTY") socket.emit("market:update", { prevCloseNifty: close });
                if (sym === "INDIAVIX") socket.emit("market:update", { prevCloseVix: close });
              }
            }
          } catch {}
        }
      }
    })();
  } catch (e) {}
  // FE will emit this when user picks an expiry
  socket.on("oc:select", ({ symbol, expiry }) => {
    if (!symbol || !expiry) return;
    wsSubscribeChain(String(symbol), String(expiry));
  });
  socket.on("disconnect", () => console.log("client disconnected", socket.id));
});

// No synthetic ticks; real WS + REST only

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
