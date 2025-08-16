// server/src/routes/market.ts
import { Router, Request, Response } from "express";
import { auth } from "../middleware/auth";
import {
  fetchOptionChain,
  getCachedOptionChain,
  getProvider,
  setProvider,
} from "../services/dataFeed";
import { Provider } from "../adapters/types";
import { getExpiries as dhanGetExpiries } from "../adapters/dhan";
import { wsSubscribeChain } from "../ws/dhanFeed";
import prisma from "../db";
import { getCurrentPCR, getPCROpen } from "../ws/dhanFeed";
import { loadDhanInstrumentMaps } from "../lib/dhanInstruments";
import path from "path";
import { getHistoricalLastClose, getExpiries as dhanExpiries, getOptionChainRaw, INDEX_SCRIP } from "../adapters/dhan";
const router = Router();

// Lightweight in-memory cache for hydrate-topbar to curb repeated historical calls
type HydrateCacheEntry = { ts: number; data: any };
const hydrateCache = new Map<string, HydrateCacheEntry>();

// GET active provider
router.get("/provider", (_req: Request, res: Response) => {
  res.json({ provider: getProvider() });
});

// PATCH set provider { provider: "dhan"|"kite" }
router.patch("/provider", auth, (req: Request, res: Response) => {
  const p = String(req.body?.provider || "").toLowerCase() as Provider;
  if (!["dhan", "kite"].includes(p)) {
    return res
      .status(400)
      .json({ error: "Invalid provider. Allowed: 'dhan' | 'kite' (synthetic disabled)" });
  }
  setProvider(p);
  res.json({ provider: p });
});

// GET expiries (Dhan implemented)
router.get("/expiries", auth, async (req: Request, res: Response) => {
  const symbol = String(req.query.symbol || "NIFTY");
  const provider = getProvider();
  res.setHeader("X-Market-Provider", provider);

  try {
    if (provider === "dhan") {
      const expiries = await dhanGetExpiries(symbol);
      return res.json({ provider, expiries });
    }
    return res.status(501).json({ error: "Expiries not implemented for provider", provider });
  } catch (e: any) {
    return res.status(500).json({ error: e?.message || "Failed to fetch expiries", provider });
  }
});

// GET option chain
// Query: ?symbol=NIFTY&expiry=YYYY-MM-DD[&cached=1]
router.get("/option-chain", auth, async (req: Request, res: Response) => {
  const symbol = String(req.query.symbol || "NIFTY");
  const expiry = String(req.query.expiry || "");
  const cached = String(req.query.cached || "") === "1";
  if (!expiry) return res.status(400).json({ error: "expiry required" });

  const provider = getProvider();
  res.setHeader("X-Market-Provider", provider);

  try {
    const snap = cached
      ? getCachedOptionChain(symbol, expiry)
      : await fetchOptionChain(symbol, expiry);

    if (provider === "dhan") {
      try {
        wsSubscribeChain(symbol, expiry);
      } catch {}
    }
    // expose last price in header too (useful for debugging)
    if (Number.isFinite(Number(snap.lastPrice))) {
      res.setHeader("X-Underlying-Last", String(snap.lastPrice));
    }

    return res.json({ provider, rows: snap.rows, lastPrice: snap.lastPrice, source: snap.source });
  } catch (e: any) {
    return res.status(500).json({ error: e?.message || "Failed to fetch option chain", provider });
  }
});

// GET /market/hydrate-topbar?symbol=NIFTY&expiry=YYYY-MM-DD
// Returns: { spot, vix, prevCloseNifty?, prevCloseVix?, fut?, pcr? }
router.get("/hydrate-topbar", async (req: Request, res: Response) => {
  const symbol = String(req.query.symbol || "NIFTY").toUpperCase();
  const expiry = String(req.query.expiry || "");
  const cacheKey = `${symbol}|${expiry || "-"}`;
  const hit = hydrateCache.get(cacheKey);
  if (hit && Date.now() - hit.ts < 120_000) {
    const d = hit.data || {};
    const okPrev = [d.prevCloseNifty, d.prevCloseBank, d.prevCloseVix].every((x: any) => Number.isFinite(Number(x)));
    if (okPrev) return res.json(d);
    // else fall through to recompute so we include prevClose*
  }
  try {
  const [idxRows, futRow] = await Promise.all([
      (prisma as any).lastIndexTick.findMany({ where: { symbol: { in: ["NIFTY", "BANKNIFTY", "INDIAVIX"] } } }),
      (prisma as any).lastFutTick.findFirst({ where: { symbol }, orderBy: { id: "desc" } }),
    ]);
    const bySym = new Map<string, any>(idxRows.map((r: any) => [String(r.symbol).toUpperCase(), r]));
    let spot = Number((bySym.get("NIFTY") as any)?.ltp);
  let vix = Number((bySym.get("INDIAVIX") as any)?.ltp);
  let bank = Number((bySym.get("BANKNIFTY") as any)?.ltp);
    const out: any = {};

    // Market clock (IST)
    const now = new Date();
    const utcMs = now.getTime() + now.getTimezoneOffset() * 60000;
    const ist = new Date(utcMs + 5.5 * 60 * 60000);
    const day = ist.getDay();
    const mins = ist.getHours() * 60 + ist.getMinutes();
    const open = day >= 1 && day <= 5 && mins >= 9 * 60 + 15 && mins <= 15 * 60 + 30;

  // If market closed, fetch last trading day's close via Dhan historic once per index
  // and anchor prevClose to the trading day before that. Keep calls minimal for fast hydration.
  let usedDateNifty: string | undefined;
  let usedDateVix: string | undefined;
  let usedDateBank: string | undefined;

  if (!open) {
      try {
        const toISO = (d: Date) => new Date(d.getTime() - d.getTimezoneOffset() * 60000)
          .toISOString()
          .slice(0, 10);
        const decTradingDay = (d: Date) => {
          const x = new Date(d.getTime());
          x.setDate(x.getDate() - 1);
          if (x.getDay() === 0) x.setDate(x.getDate() - 2); // Sun -> Fri
          if (x.getDay() === 6) x.setDate(x.getDate() - 1); // Sat -> Fri
          return x;
        };

        // Load NSE_INDEX securityIds from CSV (if available)
        let idxSid: Record<string, string | undefined> = {};
        try {
          const csv = process.env.DHAN_INSTRUMENTS_CSV || path.resolve(__dirname, "../../data/dhan_instruments.csv");
          const maps = loadDhanInstrumentMaps(csv);
          idxSid = {
            NIFTY: maps.idxSpot.get("NIFTY"),
            BANKNIFTY: maps.idxSpot.get("BANKNIFTY"),
            INDIAVIX: maps.idxSpot.get("INDIAVIX"),
          } as any;
        } catch {}

        async function getCloseFor(sym: "NIFTY" | "BANKNIFTY" | "INDIAVIX", date: string): Promise<number | undefined> {
          // Try NSE_INDEX first if we have a securityId
          const sid = idxSid[sym];
          if (sid) {
            const r = await getHistoricalLastClose({ securityId: sid, exchangeSegment: "NSE_INDEX" as any, instrument: "INDEX" as any, date, withOi: false }).catch(() => undefined);
            const c = Number(r?.close);
            if (Number.isFinite(c) && c > 0) return c;
          }
          // Fallback to IDX_I using known index scrip ids
          const scrip = String((INDEX_SCRIP as any)[sym] || "");
          if (scrip) {
            const r2 = await getHistoricalLastClose({ securityId: scrip, exchangeSegment: "IDX_I" as any, instrument: "INDEX" as any, date, withOi: false }).catch(() => undefined);
            const c2 = Number(r2?.close);
            if (Number.isFinite(c2) && c2 > 0) return c2;
          }
          return undefined;
        }

        async function findLatestTwo(sym: "NIFTY" | "BANKNIFTY" | "INDIAVIX"): Promise<{ curr?: { date: string; close: number }, prev?: { date: string; close: number } }> {
          let d = decTradingDay(ist);
          let attempts = 0;
          let curr: { date: string; close: number } | undefined;
          while (attempts++ < 7) {
            const date = toISO(d);
            const c = await getCloseFor(sym, date);
            if (Number.isFinite(Number(c)) && Number(c) > 0) {
              curr = { date, close: Number(c) };
              break;
            }
            d = decTradingDay(d);
          }
          if (!curr) return {};
          // find previous trading day's close (not equal to current)
          let d2 = decTradingDay(new Date(curr.date + "T00:00:00"));
          attempts = 0;
          while (attempts++ < 7) {
            const date = toISO(d2);
            const c = await getCloseFor(sym, date);
            if (Number.isFinite(Number(c)) && Number(c) > 0 && Math.abs(Number(c) - curr.close) > 1e-6) {
              return { curr, prev: { date, close: Number(c) } };
            }
            d2 = decTradingDay(d2);
          }
          return { curr };
        }

        // NIFTY
        {
          const r = await findLatestTwo("NIFTY");
          if (r.curr) {
            spot = r.curr.close;
            usedDateNifty = r.curr.date;
            await (prisma as any).lastIndexTick
              .upsert({ where: { symbol: "NIFTY" }, update: { ltp: r.curr.close, ts: Date.now() as any }, create: { symbol: "NIFTY", ltp: r.curr.close, ts: Date.now() as any } })
              .catch(() => {});
          }
          if (r.prev) out.prevCloseNifty = r.prev.close;
        }

        // INDIAVIX
        {
          const r = await findLatestTwo("INDIAVIX");
          if (r.curr) {
            vix = r.curr.close;
            usedDateVix = r.curr.date;
            await (prisma as any).lastIndexTick
              .upsert({ where: { symbol: "INDIAVIX" }, update: { ltp: r.curr.close, ts: Date.now() as any }, create: { symbol: "INDIAVIX", ltp: r.curr.close, ts: Date.now() as any } })
              .catch(() => {});
          }
          if (r.prev) out.prevCloseVix = r.prev.close;
        }

        // BANKNIFTY
        {
          const r = await findLatestTwo("BANKNIFTY");
          if (r.curr) {
            bank = r.curr.close;
            usedDateBank = r.curr.date;
            await (prisma as any).lastIndexTick
              .upsert({ where: { symbol: "BANKNIFTY" }, update: { ltp: r.curr.close, ts: Date.now() as any }, create: { symbol: "BANKNIFTY", ltp: r.curr.close, ts: Date.now() as any } })
              .catch(() => {});
          }
          if (r.prev) out.prevCloseBank = r.prev.close;
        }
      } catch {}
    }

    // Always include previous trading day's closes for deltas (based on usedDate* or now)
    try {
      const toISO = (d: Date) => new Date(d.getTime() - d.getTimezoneOffset() * 60000)
        .toISOString()
        .slice(0, 10);
      const decTradingDay = (d: Date) => {
        const base = new Date(d.getTime());
        base.setDate(base.getDate() - 1);
        if (base.getDay() === 0) base.setDate(base.getDate() - 2); // Sun -> Fri
        if (base.getDay() === 6) base.setDate(base.getDate() - 1); // Sat -> Fri
        return base;
      };
      const prevFromAnchor = (anchor?: string) => {
        if (anchor) {
          const d = new Date(anchor + "T00:00:00Z");
          if (Number.isFinite(d.getTime())) return d;
        }
        return new Date(ist.getTime());
      };

      async function getPrevClose(idxSid: string | undefined, scripId: string | undefined, anchor?: string, notEqualTo?: number) {
        // Try up to 4 previous trading days to account for holidays
        let dt = prevFromAnchor(anchor);
        for (let i = 0; i < 4; i++) {
          dt = decTradingDay(dt);
          const date = toISO(dt);
          // prefer NSE_INDEX securityId if provided
          if (idxSid) {
            const r = await getHistoricalLastClose({ securityId: idxSid, exchangeSegment: "NSE_INDEX" as any, instrument: "INDEX" as any, date, withOi: false }).catch(() => undefined);
            const close = Number(r?.close);
            if (Number.isFinite(close) && close > 0) {
              if (Number.isFinite(notEqualTo) && Math.abs(close - Number(notEqualTo)) < 1e-6) {
                // same as current, try an earlier trading day
              } else {
                return close;
              }
            }
          }
          if (scripId) {
            const r2 = await getHistoricalLastClose({ securityId: scripId, exchangeSegment: "IDX_I", instrument: "INDEX", date, withOi: false }).catch(() => undefined);
            const c2 = Number(r2?.close);
            if (Number.isFinite(c2) && c2 > 0) {
              if (Number.isFinite(notEqualTo) && Math.abs(c2 - Number(notEqualTo)) < 1e-6) {
                // same as current, keep searching
              } else {
                return c2;
              }
            }
          }
        }
        return undefined;
      }

      // Resolve NSE_INDEX securityIds via CSV + env overrides
      let idxSidNifty: string | undefined, idxSidBank: string | undefined, idxSidVix: string | undefined;
      try {
        const csv = process.env.DHAN_INSTRUMENTS_CSV || path.resolve(__dirname, "../../data/dhan_instruments.csv");
        const maps = loadDhanInstrumentMaps(csv);
        idxSidNifty = maps.idxSpot.get("NIFTY");
        idxSidBank  = maps.idxSpot.get("BANKNIFTY");
        idxSidVix   = maps.idxSpot.get("INDIAVIX");
      } catch {}

  // Build anchors: prefer computed usedDate*; if market is closed, default anchor is prev trading day; else fall back to DB ts
  const tsNifty = Number((bySym.get("NIFTY") as any)?.ts);
  const tsBank  = Number((bySym.get("BANKNIFTY") as any)?.ts);
  const tsVix   = Number((bySym.get("INDIAVIX") as any)?.ts);
  const toISODate = (ms?: number) => (Number.isFinite(ms) ? toISO(new Date(Number(ms))) : undefined);
  const defaultAnchorStr = !open ? toISO(decTradingDay(new Date(ist.getTime()))) : undefined;
  const anchorNifty = usedDateNifty || defaultAnchorStr || toISODate(tsNifty);
  const anchorBank  = usedDateBank  || defaultAnchorStr || toISODate(tsBank);
  const anchorVix   = usedDateVix   || defaultAnchorStr || toISODate(tsVix);

      // NIFTY prev close (holiday aware, anchored to spot date)
      if (!Number.isFinite(out.prevCloseNifty)) {
        out.prevCloseNifty = await getPrevClose(idxSidNifty, String(INDEX_SCRIP.NIFTY || ""), anchorNifty, spot);
      }
      // BANKNIFTY prev close
      if (!Number.isFinite(out.prevCloseBank)) {
        out.prevCloseBank = await getPrevClose(idxSidBank, String(INDEX_SCRIP.BANKNIFTY || ""), anchorBank, bank);
      }
      // INDIAVIX prev close
      if (!Number.isFinite(out.prevCloseVix)) {
        out.prevCloseVix = await getPrevClose(idxSidVix, String(INDEX_SCRIP.INDIAVIX || ""), anchorVix, vix);
      }
    } catch {}

    if (Number.isFinite(spot)) out.spot = spot;
  if (Number.isFinite(vix)) out.vix = vix;
  if (Number.isFinite(bank)) out.bank = bank;
    if (Number.isFinite(Number(futRow?.ltp))) out.fut = Number(futRow.ltp);

    // Try PCR if expiry provided (may be undefined after-hours)
    if (expiry) {
      const pcr = getCurrentPCR(symbol, expiry);
      if (Number.isFinite(Number(pcr))) {
        out.pcr = Number(pcr);
      }
      const pcrOpen = getPCROpen(symbol, expiry);
      if (Number.isFinite(Number(pcrOpen))) out.pcrOpen = Number(pcrOpen);
    }

    // After-hours or when WS OI isn't available, fallback to computing PCR from option-chain snapshot
    if (!Number.isFinite(Number(out.pcr))) {
      try {
        const sym = symbol.toUpperCase();
        let expUse = expiry;
        if (!expUse) {
          // pick nearest expiry from Dhan if none provided
          const list = await dhanExpiries(sym).catch(() => [] as string[]);
          expUse = Array.isArray(list) && list.length ? String(list[0]) : "";
        }
        if (expUse) {
          // prefer cache/store, then single-shot fetch to seed if empty
          let snap = getCachedOptionChain(sym, expUse);
          if (!Array.isArray(snap?.rows) || snap.rows.length === 0) {
            snap = await fetchOptionChain(sym, expUse).catch(() => ({ rows: [] } as any));
          }
          const rows = Array.isArray(snap?.rows) ? snap.rows : [];
      if (rows.length) {
            let call = 0, put = 0;
            for (const r of rows) {
              const co = Number((r as any)?.callOi);
              const po = Number((r as any)?.putOi);
              if (Number.isFinite(co)) call += co;
              if (Number.isFinite(po)) put += po;
            }
            const calc = call > 0 ? put / call : undefined;
            if (Number.isFinite(Number(calc))) {
              out.pcr = Number(calc);
        // We cannot reliably compute previous-day PCR from current snapshot; leave pcrOpen undefined.
            }
          }
        }
      } catch {}
    }
  // cache for 2 minutes to avoid bursty historical calls
  try { hydrateCache.set(cacheKey, { ts: Date.now(), data: out }); } catch {}
  return res.json(out);
  } catch (e: any) {
    return res.status(500).json({ error: e?.message || "Failed to hydrate topbar" });
  }
});

// Public GET: /market/historical-close?sid=21&date=2025-08-14[&exch=NSE_INDEX&instr=INDEX&withOi=1]
router.get("/historical-close", async (req: Request, res: Response) => {
  try {
    const sid = String((req.query.sid || req.query.securityId || "").toString().trim());
    const date = String((req.query.date || "").toString().trim());
    const exch = (String(req.query.exch || req.query.exchangeSegment || "NSE_INDEX").toUpperCase()) as any;
    const instr = (String(req.query.instr || req.query.instrument || "INDEX").toUpperCase()) as any;
    const withOi = String(req.query.withOi || "") === "1";

    if (!sid || !date) {
      return res.status(400).json({ error: "sid and date are required (YYYY-MM-DD)", example: "/api/market/historical-close?sid=21&date=2025-08-14" });
    }

    const out = await getHistoricalLastClose({
      securityId: sid,
      exchangeSegment: exch,
      instrument: instr,
      date,
      withOi,
    } as any).catch((e: any) => ({ error: String(e?.message || e) }));

    return res.json({ input: { sid, date, exch, instr, withOi }, result: out });
  } catch (e: any) {
    return res.status(500).json({ error: e?.message || "historical-close failed" });
  }
});

// GET /market/debug/historical-close?sid=21&date=2025-08-14[&exch=NSE_INDEX&instr=INDEX&withOi=1]
// Auth-protected: simple one-off validator to check if a securityId returns data on a given date
router.get("/debug/historical-close", auth, async (req: Request, res: Response) => {
  try {
    const sid = String((req.query.sid || req.query.securityId || "").toString().trim());
    const date = String((req.query.date || "").toString().trim());
    const exch = (String(req.query.exch || req.query.exchangeSegment || "NSE_INDEX").toUpperCase()) as any;
    const instr = (String(req.query.instr || req.query.instrument || "INDEX").toUpperCase()) as any;
    const withOi = String(req.query.withOi || "") === "1";

    if (!sid || !date) {
      return res.status(400).json({ error: "sid and date are required (YYYY-MM-DD)", example: "/api/market/debug/historical-close?sid=21&date=2025-08-14" });
    }

    const out = await getHistoricalLastClose({
      securityId: sid,
      exchangeSegment: exch,
      instrument: instr,
      date,
      withOi,
    } as any).catch((e: any) => ({ error: String(e?.message || e) }));

    return res.json({ input: { sid, date, exch, instr, withOi }, result: out });
  } catch (e: any) {
    return res.status(500).json({ error: e?.message || "debug historical-close failed" });
  }
});

export default router;
