import fs from "fs";
import path from "path";
import prisma from "../db";
import { loadDhanInstrumentMaps } from "../lib/dhanInstruments";
import { setTimeout as sleep } from "timers/promises";
import WebSocket from "ws";
import { Server } from "socket.io";

// Helper to get last futures price from file
export async function getLastFutPriceFromDB(symbol = "NIFTY") {
  try {
    const csvPath = process.env.DHAN_INSTRUMENTS_CSV || (fs.existsSync(path.resolve("data/dhan_instruments.csv")) ? "data/dhan_instruments.csv" : "server/data/dhan_instruments.csv");
    const maps = loadDhanInstrumentMaps(csvPath);
    // maps.idxFut maps symbol -> secId (nearest monthly fut secId)
    const secId = maps.idxFut.get((symbol || "").toUpperCase());
    let desiredExpiry: string | undefined = undefined;
    if (secId) {
      const meta = maps.bySecId.get(secId);
      if (meta?.expiry) desiredExpiry = meta.expiry;
    }

    if (desiredExpiry) {
      const row = await (prisma as any).lastFutTick.findFirst({ where: { symbol: symbol.toUpperCase(), expiry: desiredExpiry } });
      if (row) {
        const ltpVal = Number(row.ltp);
        if (Number.isFinite(ltpVal) && ltpVal >= 1) return { provider: "dhan", symbol: row.symbol, expiry: row.expiry, ltp: ltpVal, ts: Number(row.ts) };
      }
    }

    // fallback to latest row for symbol
    const fallback = await (prisma as any).lastFutTick.findFirst({ where: { symbol: symbol.toUpperCase() }, orderBy: { id: "desc" } });
  if (!fallback) return null;
  const ltpVal = Number(fallback.ltp);
  if (!Number.isFinite(ltpVal) || ltpVal < 1) return null;
  return { provider: "dhan", symbol: fallback.symbol, expiry: fallback.expiry, ltp: ltpVal, ts: Number(fallback.ts) };
  } catch (e) {
    return null;
  }
}

/* ---------------- env / constants ---------------- */
const CLIENT_ID = process.env.DHAN_CLIENT_ID || "";
const ACCESS = process.env.DHAN_ACCESS_TOKEN || "";
const WS_ENABLE = process.env.DHAN_WS_ENABLE === "1";

const CSV_PATH =
  process.env.DHAN_INSTRUMENTS_CSV ||
  (fs.existsSync(path.resolve("data/dhan_instruments.csv"))
    ? "data/dhan_instruments.csv"
    : "server/data/dhan_instruments.csv");

const WS_URL = `wss://api-feed.dhan.co?version=2&token=${encodeURIComponent(
  ACCESS
)}&clientId=${encodeURIComponent(CLIENT_ID)}&authType=2`;

const DBG: boolean = process.env.DEBUG_DHAN_WS === "1";

/* ---------------- request/packet codes ---------------- */
const SUBSCRIBE_QUOTE = 17;
const UNSUBSCRIBE_QUOTE = 18;

const RC_TICKER = 2;
const RC_QUOTE = 4;
const RC_OI = 5;
const RC_PREV_CLOSE = 6;
const RC_FULL = 8;
const RC_DISCONNECT = 50;

/* ---------------- CSV parsing helpers ---------------- */
type ExchReq = "NSE_FNO" | "NSE_INDEX";
type CsvRow = Record<string, string>;

function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "",
    q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (q && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else {
        q = !q;
      }
    } else if (ch === "," && !q) {
      out.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out;
}

function slurpCsv(file: string): CsvRow[] {
  const abs = path.resolve(file);
  if (!fs.existsSync(abs)) throw new Error(`Dhan instruments CSV not found at ${abs}`);
  const raw = fs.readFileSync(abs, "utf8");
  const lines = raw.split(/\r?\n/).filter(Boolean);
  if (!lines.length) return [];
  const headers = parseCsvLine(lines[0]).map((h) => h.trim());
  const rows: CsvRow[] = [];
  for (let li = 1; li < lines.length; li++) {
    const cols = parseCsvLine(lines[li]);
    const obj: CsvRow = {};
    headers.forEach((h, i) => {
      const v = (cols[i] ?? "").trim();
      obj[h] = v;
      obj[h.toLowerCase()] = v;
    });
    rows.push(obj);
  }
  return rows;
}

function pick(o: CsvRow, ...names: string[]): string {
  for (const n of names) {
    const v = o[n] ?? (o as any)[n?.toLowerCase?.()] ?? (o as any)[n?.toUpperCase?.()];
    if (v != null && v !== "") return v;
  }
  return "";
}

function parseExpiryToISO(s: string): string | undefined {
  const v = (s || "").trim();
  if (!v) return undefined;
  // DD/MM/YY or DD/MM/YYYY from SM_EXPIRY_DATE
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/.exec(v);
  if (m) {
    let dd = Number(m[1]),
      mm = Number(m[2]),
      yy = Number(m[3]);
    if (yy < 100) yy += 2000;
    const d = new Date(Date.UTC(yy, mm - 1, dd));
    return d.toISOString().slice(0, 10);
  }
  // or already ISO
  if (/^\d{4}-\d{2}-\d{2}/.test(v)) return v.slice(0, 10);
  const d = new Date(v);
  if (!Number.isFinite(d.getTime())) return undefined;
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
}
function toNum(s: string): number | undefined {
  const n = Number(s);
  return Number.isFinite(n) ? n : undefined;
}
function normalizeSymbol(raw: string): string | undefined {
  const s = (raw || "").toUpperCase();
  if (!s) return undefined;
  // match longer/specific symbols first to avoid substring collisions
  if (s.includes("FINNIFTY")) return "FINNIFTY";
  if (s.includes("BANK")) return "BANKNIFTY";
  if (s.includes("NIFTY")) return "NIFTY";
  return s;
}

/* ---------------- mapping model ---------------- */
type InstrMeta = {
  secId: string; // SecurityId
  exch: ExchReq; // NSE_FNO | NSE_INDEX
  symbol?: string; // NIFTY, BANKNIFTY, etc.
  expiry?: string; // YYYY-MM-DD
  strike?: number;
  optType?: "CE" | "PE";
  isIndex?: boolean;
  isFut?: boolean;
  underlyingId?: string;
};

function buildMapping(csvFile: string) {
  const rows = slurpCsv(csvFile);
  const bySecId = new Map<string, InstrMeta>();
  const chainIndex = new Map<string, string[]>(); // key: sym|expiry -> [secId...]
  const idxSpot = new Map<string, string>(); // sym -> index secId
  const idxFut = new Map<string, string>(); // sym -> nearest monthly fut secId

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  for (const r of rows) {
    // exact columns per your requirement
    const exchId = pick(r, "EXCH_ID");
    const segment = pick(r, "SEGMENT");
    const instrument = (pick(r, "INSTRUMENT") || "").toUpperCase(); // INDEX/OPTIDX/FUTIDX
    const instrType = (pick(r, "INSTRUMENT_TYPE") || "").toUpperCase(); // FUT/OPT/...
    const secId = pick(r, "SECURITY_ID");
    if (!secId) continue;

    // exchange segment to use in WS payloads
    let exch: ExchReq | undefined;
    if (instrument === "INDEX") exch = "NSE_INDEX";
    else if (exchId === "NSE" && segment === "D") exch = "NSE_FNO";
    else continue;

    const symbol = normalizeSymbol(pick(r, "UNDERLYING_SYMBOL", "SYMBOL_NAME", "DISPLAY_NAME"));
    if (!symbol) continue;

    const expiry = parseExpiryToISO(pick(r, "SM_EXPIRY_DATE", "EXPIRY_DATE"));
    const strike = toNum(pick(r, "STRIKE_PRICE"));
    const optTypeRaw = (pick(r, "OPTION_TYPE") || "").toUpperCase();
    const optType =
      optTypeRaw === "CE" || optTypeRaw === "PE" ? (optTypeRaw as "CE" | "PE") : undefined;

    const isIndex = instrument === "INDEX";
    // FUT detection: only pick NSE FUTIDX rows on segment D with an expiry
    const underlyingId = pick(r, "UNDERLYING_SECURITY_ID");
    // FUT detection: only pick NSE FUTIDX rows on segment D with an expiry
    // For NIFTY, require underlying security id 26000 to avoid mixing with FINNIFTY or others
    const isFut =
      instrument === "FUTIDX" &&
      instrType === "FUT" &&
      exchId === "NSE" &&
      segment === "D" &&
      !!pick(r, "SM_EXPIRY_DATE") &&
      (normalizeSymbol(pick(r, "UNDERLYING_SYMBOL", "SYMBOL_NAME", "DISPLAY_NAME")) !== "NIFTY" || underlyingId === "26000");
    // Options detection: match NSE FNO option instruments (OPTIDX/OPTSTK).
    // Some CSV rows use INSTRUMENT_TYPE 'OP' instead of 'OPT', so don't rely on instrType === 'OPT'.
    const isOpt = exch === "NSE_FNO" && (instrument === "OPTIDX" || instrument === "OPTSTK");

  const meta: InstrMeta = { secId, exch, symbol, expiry, strike, optType, isIndex, isFut, underlyingId };
    bySecId.set(secId, meta);

    if (isIndex) {
      if (symbol === "NIFTY") idxSpot.set("NIFTY", secId);
      if (symbol === "BANKNIFTY") idxSpot.set("BANKNIFTY", secId);
      // Also map VIX if present in CSV
      if (symbol === "INDIAVIX" || symbol?.includes?.("VIX")) idxSpot.set("INDIAVIX", secId);
    }

    if (isOpt && expiry && typeof strike === "number" && optType) {
      const key = `${symbol}|${expiry}`;
      const arr = chainIndex.get(key) || [];
      arr.push(secId);
      chainIndex.set(key, arr);
    }

    if (isFut && expiry) {
      const prev = idxFut.get(symbol);
      if (!prev) {
        idxFut.set(symbol, secId);
      } else {
        const prevMeta = bySecId.get(prev);
        const dPrev = prevMeta?.expiry ? new Date(prevMeta.expiry + "T00:00:00Z") : undefined;
        const dThis = new Date(expiry + "T00:00:00Z");
        if (dThis >= today && (!dPrev || dPrev < today || dThis < dPrev)) idxFut.set(symbol, secId);
      }
    }
  }

  // Environment overrides to ensure critical mappings exist even if CSV lacks NSE index rows
  try {
    const envNifty = (process.env.DHAN_NIFTY_SID || "").trim();
    const envBank  = (process.env.DHAN_BANKNIFTY_SID || "").trim();
    const envVix   = (process.env.DHAN_INDIAVIX_SID || process.env.DHAN_VIX_SID || "").trim();
    const envNiftyFut = (process.env.DHAN_NIFTY_FUT_SID || "").trim();
    const envBankFut  = (process.env.DHAN_BANKNIFTY_FUT_SID || "").trim();

    if (envNifty) {
      idxSpot.set("NIFTY", envNifty);
      if (!bySecId.has(envNifty)) bySecId.set(envNifty, { secId: envNifty, exch: "NSE_INDEX", symbol: "NIFTY", isIndex: true });
    }
    if (envBank) {
      idxSpot.set("BANKNIFTY", envBank);
      if (!bySecId.has(envBank)) bySecId.set(envBank, { secId: envBank, exch: "NSE_INDEX", symbol: "BANKNIFTY", isIndex: true });
    }
    if (envVix) {
      idxSpot.set("INDIAVIX", envVix);
      if (!bySecId.has(envVix)) bySecId.set(envVix, { secId: envVix, exch: "NSE_INDEX", symbol: "INDIAVIX", isIndex: true });
    }
    if (envNiftyFut) {
      idxFut.set("NIFTY", envNiftyFut);
      if (!bySecId.has(envNiftyFut)) bySecId.set(envNiftyFut, { secId: envNiftyFut, exch: "NSE_FNO", symbol: "NIFTY", isFut: true });
    }
    if (envBankFut) {
      idxFut.set("BANKNIFTY", envBankFut);
      if (!bySecId.has(envBankFut)) bySecId.set(envBankFut, { secId: envBankFut, exch: "NSE_FNO", symbol: "BANKNIFTY", isFut: true });
    }
  } catch {}

  if (DBG) {
    console.log(
      `[DHAN-WS] mapping built: bySecId=${bySecId.size}, chains=${chainIndex.size}, idxSpot=${idxSpot.size}, idxFut=${idxFut.size}`
    );
    for (const sym of ["NIFTY", "BANKNIFTY"]) {
      const expiries = new Set<string>();
      for (const key of chainIndex.keys())
        if (key.startsWith(sym + "|")) expiries.add(key.split("|")[1]!);
      const list = Array.from(expiries).sort();
      console.log(
        `[DHAN-WS] expiries[${sym}] = ${list.slice(0, 12).join(", ")}${
          list.length > 12 ? ", ..." : ""
        }`
      );
    }
    // print chosen futures secIds for quick debug
    const dump = (name: string) => {
      const v = idxFut.get(name);
      if (v) console.log(`[DHAN-WS] idxFut[${name}] = ${v} -> ${JSON.stringify(bySecId.get(v))}`);
      else console.log(`[DHAN-WS] idxFut[${name}] = <none>`);
    };
    dump("NIFTY");
    dump("FINNIFTY");
  }

  return { bySecId, chainIndex, idxSpot, idxFut };
}

/* ---------------- binary decoding ---------------- */
function readI32_BE(buf: Buffer, off: number): number {
  return buf.readInt32BE(off);
}
function readU32_LE(buf: Buffer, off: number): number {
  return buf.readUInt32LE(off);
}
function readU32_BE(buf: Buffer, off: number): number {
  return buf.readUInt32BE(off);
}
function readF32_BE(buf: Buffer, off: number): number {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  return dv.getFloat32(off, false);
}
function readF32_LE(buf: Buffer, off: number): number {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  return dv.getFloat32(off, true);
}
function readF32_auto(buf: Buffer, off: number): number {
  const be = readF32_BE(buf, off);
  const le = readF32_LE(buf, off);
  const valid = (v: number) => Number.isFinite(v) && v > 0 && v < 10_000_000;
  // prefer realistic prices (>= 1). If BE looks sane, use it; otherwise prefer LE.
  if (valid(be) && be >= 1) return be;
  if (valid(le) && le >= 1) return le;
  // fallback to any valid small value if present
  if (valid(be)) return be;
  if (valid(le)) return le;
  return NaN;
}

/* ---------------- public tick payloads ---------------- */
export type TickLTP = {
  symbol?: string;
  expiry?: string;
  strike?: number;
  type?: "CE" | "PE";
  ltp: number;
  ts: number;
};
export type TickOI = {
  symbol?: string;
  expiry?: string;
  strike?: number;
  type?: "CE" | "PE";
  oi: number;
  ts: number;
};

/* ---------------- feed class ---------------- */
type SubKey = string; // exch|secId
function subKey(exch: ExchReq, secId: string): SubKey {
  return `${exch}|${secId}`;
}

export class DhanFeed {
  public lastFutTick: any = null;
  private io?: Server;
  private ws?: WebSocket;
  private closing = false;
  private connected = false;

  private bySecId!: Map<string, InstrMeta>;
  private chainIndex!: Map<string, string[]>;
  private idxSpot!: Map<string, string>;
  private idxFut!: Map<string, string>;

  private chainRefs = new Map<string, number>(); // key=symbol|expiry
  private wantSubs = new Set<SubKey>();
  private wantUnsubs = new Set<SubKey>();
  private subbed = new Set<SubKey>();
  private batchTimer?: NodeJS.Timeout;

  // Track OI per expiry to compute PCR in realtime
  private oiByExpiry: Map<string, { ce: Map<number, number>; pe: Map<number, number> } > = new Map();
  // Track first computed PCR of the session as an "open" baseline per symbol|expiry
  private pcrOpenByExpiry: Map<string, number> = new Map();

  constructor(io?: Server) {
    this.io = io;
  }

  async init() {
    const maps = buildMapping(CSV_PATH);
    this.bySecId = maps.bySecId;
    this.chainIndex = maps.chainIndex;
    this.idxSpot = maps.idxSpot;
    this.idxFut = maps.idxFut;
    if (DBG) {
      console.log(
        `[DHAN-WS][INDEX] idxSpot mappings => NIFTY=${this.idxSpot.get("NIFTY") || "-"}, INDIAVIX=${this.idxSpot.get("INDIAVIX") || "-"}`
      );
    }

    // log current persisted last fut tick for debugging
    if (DBG || process.env.DEBUG_DHAN_WS === "1") {
      getLastFutPriceFromDB().then((t) => {
        if (t) console.log(`[DHAN-WS] persisted last fut tick on init: ${JSON.stringify(t)}`);
      }).catch(() => {});
    }

  if (!WS_ENABLE) {
      console.warn("[DHAN-WS] DHAN_WS_ENABLE != 1 — WebSocket feed disabled");
      return;
    }
    if (!CLIENT_ID || !ACCESS) {
      console.warn(
        "[DHAN-WS] Missing DHAN_CLIENT_ID / DHAN_ACCESS_TOKEN — WebSocket feed disabled"
      );
      return;
    }
    await this.connectLoop();
    // After connecting, proactively subscribe to NIFTY and INDIAVIX index if available
  const spotIds: string[] = [];
  for (const base of ["NIFTY", "BANKNIFTY", "INDIAVIX"]) {
      const id = this.idxSpot.get(base);
      if (id) {
        this.wantSubs.add(subKey("NSE_INDEX", id));
        spotIds.push(id);
    if (DBG) console.log(`[DHAN-WS][INDEX] will subscribe ${base} NSE_INDEX secId=${id}`);
      } else if (DBG) {
        console.warn(`[DHAN-WS][INDEX] missing idxSpot secId for ${base}`);
      }
    }
    if (spotIds.length) this.scheduleBatch(50);
  }

  subscribeChain(symbol: string, expiry: string) {
    const sym = (symbol || "").toUpperCase();
    const key = `${sym}|${expiry}`;
    this.chainRefs.set(key, (this.chainRefs.get(key) || 0) + 1);

    const list = this.chainIndex.get(key) || [];
    for (const secId of list) {
      const meta = this.bySecId.get(secId);
      if (!meta) continue;
      this.wantSubs.add(subKey(meta.exch, secId));
      this.wantUnsubs.delete(subKey(meta.exch, secId));
    }

    const spotId = this.idxSpot.get(sym);
    if (spotId) this.wantSubs.add(subKey("NSE_INDEX", spotId));
    const futId = this.idxFut.get(sym);
    if (futId) this.wantSubs.add(subKey("NSE_FNO", futId));
  // Always subscribe to India VIX index if available
  const vixId = this.idxSpot.get("INDIAVIX");
  if (vixId) this.wantSubs.add(subKey("NSE_INDEX", vixId));

    if (DBG)
      console.log(
        `[DHAN-WS] subscribeChain ${sym} ${expiry} -> strikes=${list.length} spot=${
          spotId || "-"
        } fut=${futId || "-"}`
      );
    if (process.env.DEBUG_DHAN_WS === "1") {
      const key = `${sym}|${expiry}`;
      const size = this.chainIndex.get(key)?.length || 0;
      const avail = Array.from(this.chainIndex.keys())
        .filter((k) => k.startsWith(sym + "|"))
        .slice(0, 8);
      console.log(`[DHAN-WS][DEBUG] key=${key} strikes=${size} sampleKeys=`, avail);
    }
  // Ensure we have an OI bucket for PCR
  const kPCR = `${sym}|${expiry}`;
  if (!this.oiByExpiry.has(kPCR)) this.oiByExpiry.set(kPCR, { ce: new Map(), pe: new Map() });
    this.scheduleBatch();
  }

  unsubscribeChain(symbol: string, expiry: string) {
    const sym = (symbol || "").toUpperCase();
    const key = `${sym}|${expiry}`;
    const left = (this.chainRefs.get(key) || 1) - 1;
    if (left > 0) {
      this.chainRefs.set(key, left);
      return;
    }
    this.chainRefs.delete(key);

    const list = this.chainIndex.get(key) || [];
    for (const secId of list) {
      const meta = this.bySecId.get(secId);
      if (!meta) continue;
      const sk = subKey(meta.exch, secId);
      if (this.subbed.has(sk)) this.wantUnsubs.add(sk);
      this.wantSubs.delete(sk);
    }
    this.scheduleBatch();
  }

  getIndexSecId(symbol: string): string | undefined {
    return this.idxSpot.get((symbol || "").toUpperCase());
  }

  private async connectLoop() {
    let attempt = 0;
    while (!this.closing) {
      try {
        await this.openOnce();
        attempt = 0;
        if (this.closing) break;
      } catch (e: any) {
        if (DBG) console.warn("[DHAN-WS] connect error:", e?.message || e);
      }
      attempt++;
      const delay = Math.min(30_000, 1_000 * Math.pow(2, attempt));
      if (this.io)
        this.io.emit("feed:status", { provider: "dhan", status: "reconnecting", in: delay });
      await sleep(delay);
    }
  }

  private async openOnce(): Promise<void> {
    return new Promise((resolve) => {
      const ws = new WebSocket(WS_URL, { perMessageDeflate: false, handshakeTimeout: 10_000 });
      this.ws = ws;
      this.connected = false;

      ws.on("open", () => {
        this.connected = true;
        if (DBG) console.log("[DHAN-WS] connected");
        if (this.io) this.io.emit("feed:status", { provider: "dhan", status: "connected" });
        this.scheduleBatch(100);
      });

      ws.on("message", (data: WebSocket.RawData) => this.onMessage(data as Buffer));
      ws.on("error", (err) => {
        if (DBG) console.warn("[DHAN-WS] error:", err);
      });
      ws.on("close", (code, reason) => {
        this.connected = false;
        if (this.io)
          this.io.emit("feed:status", {
            provider: "dhan",
            status: "disconnected",
            code,
            reason: reason?.toString(),
          });
        if (DBG) console.warn("[DHAN-WS] closed:", code, reason?.toString());
        resolve();
      });
    });
  }

  stop() {
    this.closing = true;
    try {
      this.ws?.close();
    } catch {}
  }

  private scheduleBatch(delay = 150) {
    if (this.batchTimer) clearTimeout(this.batchTimer);
    this.batchTimer = setTimeout(() => this.flushBatch().catch(() => {}), delay);
  }

  private async flushBatch() {
    if (!this.connected || !this.ws) return;
    const subs = Array.from(this.wantSubs).filter((k) => !this.subbed.has(k));
    const unsubs = Array.from(this.wantUnsubs);

    if (subs.length) {
      const byExch: Record<ExchReq, string[]> = { NSE_FNO: [], NSE_INDEX: [] };
      for (const s of subs) {
        const [exch, secId] = s.split("|") as [ExchReq, string];
        byExch[exch].push(secId);
      }
      for (const exch of Object.keys(byExch) as ExchReq[]) {
        const list = byExch[exch];
        if (!list.length) continue;
        const payload = {
          RequestCode: SUBSCRIBE_QUOTE,
          InstrumentCount: list.length,
          InstrumentList: list.map((secId) => ({ ExchangeSegment: exch, SecurityId: secId })),
        };
        if (DBG) console.log("[DHAN-WS] SUB", exch, list.length);
        this.ws.send(JSON.stringify(payload));
      }
      subs.forEach((k) => {
        this.subbed.add(k);
        this.wantSubs.delete(k);
      });
    }

    if (unsubs.length) {
      const byExch: Record<ExchReq, string[]> = { NSE_FNO: [], NSE_INDEX: [] };
      for (const s of unsubs) {
        const [exch, secId] = s.split("|") as [ExchReq, string];
        byExch[exch].push(secId);
      }
      for (const exch of Object.keys(byExch) as ExchReq[]) {
        const list = byExch[exch];
        if (!list.length) continue;
        const payload = {
          RequestCode: UNSUBSCRIBE_QUOTE,
          InstrumentCount: list.length,
          InstrumentList: list.map((secId) => ({ ExchangeSegment: exch, SecurityId: secId })),
        };
        if (DBG) console.log("[DHAN-WS] UNSUB", exch, list.length);
        this.ws.send(JSON.stringify(payload));
      }
      unsubs.forEach((k) => this.wantUnsubs.delete(k));
    }
  }

  /* ------------------------- packets --------------------------- */
  private onMessage(buf: Buffer) {
    if (!Buffer.isBuffer(buf) || buf.length < 8) return;

    const code = buf.readUInt8(0);

    // Dhan WS encodes SecurityId as Little-Endian UInt32
  const secIdLE = String(readU32_LE(buf, 4));
  const secIdBE = String(readU32_BE(buf, 4)); // fallback
    const now = Date.now();

    let meta = this.bySecId.get(secIdLE);
    let whichSecId = secIdLE;
    if (!meta) {
      meta = this.bySecId.get(secIdBE);
      whichSecId = secIdBE;
    }

    if (!meta && DBG) {
      console.warn("[DHAN-WS] secId not found in mapping", {
        code,
        secIdLE,
        secIdBE,
        bufLen: buf.length,
      });
    }

    switch (code) {
      case RC_TICKER: {
        // decode both endian variants for debugging and choose
        const be = readF32_BE(buf, 8);
        const le = readF32_LE(buf, 8);
        const ltp = readF32_auto(buf, 8);
        if (meta) this.emitLtp(meta, ltp, now, whichSecId, be, le);
        break;
      }
      case RC_QUOTE: {
        const be = readF32_BE(buf, 8);
        const le = readF32_LE(buf, 8);
        const ltp = readF32_auto(buf, 8);
        if (meta) this.emitLtp(meta, ltp, now, whichSecId, be, le);
        break;
      }
      case RC_OI: {
        const oi = readI32_BE(buf, 8);
        if (meta) this.emitOi(meta, oi, now);
        break;
      }
      case RC_FULL: {
        const be = readF32_BE(buf, 8);
        const le = readF32_LE(buf, 8);
        const ltp = readF32_auto(buf, 8);
        const oi = readI32_BE(buf, 34);
        if (meta) {
          this.emitLtp(meta, ltp, now, whichSecId, be, le);
          this.emitOi(meta, oi, now);
        }
        break;
      }
      case RC_PREV_CLOSE:
      case RC_DISCONNECT:
      default:
        break;
    }
  }

  private emitLtp(meta: InstrMeta, ltp: number, ts: number, secId?: string, be?: number, le?: number) {
    if (!Number.isFinite(ltp) || ltp <= 0) return;
    if (!this.io) return;

    if (meta.isIndex) {
      const sym = (meta.symbol || "NIFTY").toUpperCase();
      if (DBG) console.log(`[DHAN-WS][INDEX] LTP ${sym} secId=${secId || "?"} ltp=${ltp}`);
      this.io.emit("feed:spot", { provider: "dhan", symbol: sym, ltp, ts });
      // persist last index ticks (NIFTY / INDIAVIX)
      try {
        (prisma as any).lastIndexTick
          .upsert({
            where: { symbol: sym },
            update: { ltp, ts: ts as any },
            create: { symbol: sym, ltp, ts: ts as any },
          })
          .catch(() => {});
      } catch {}
      // also broadcast a unified market:update for Topbar convenience
      if (sym === "INDIAVIX") {
        this.io.emit("market:update", { vix: ltp });
      } else if (sym === "NIFTY") {
        this.io.emit("market:update", { spot: ltp });
      } else if (sym === "BANKNIFTY") {
        this.io.emit("market:update", { bank: ltp });
      }
      return;
    }
    if (meta.isFut) {
      const futTick = {
        provider: "dhan",
        symbol: meta.symbol || "NIFTY",
        expiry: meta.expiry,
        ltp,
        ts,
      };
      // ignore clearly invalid tiny floats (likely decode artifact)
      if (!Number.isFinite(ltp) || ltp <= 0 || ltp < 1) {
        if (DBG) console.warn(`[DHAN-WS] ignoring suspicious FUT ltp secId=${secId} symbol=${meta.symbol} expiry=${meta.expiry} ltp=${ltp} be=${be} le=${le}`);
        return;
      }
      if (DBG) console.log(`[DHAN-WS] FUT tick secId=${secId} symbol=${meta.symbol} expiry=${meta.expiry} ltp=${ltp} be=${be} le=${le}`);
      this.io.emit("feed:fut", futTick);
      // legacy compatibility
      this.io.emit("oc:tick", { symbol: meta.symbol, expiry: meta.expiry, ltp, ts } as any);
  // persist to DB (upsert latest)
      try {
        // upsert to keep a single latest row per symbol
        (prisma as any).lastFutTick
          .upsert({
            where: { symbol: futTick.symbol },
            update: { expiry: futTick.expiry || null, ltp: futTick.ltp, ts: futTick.ts as any },
            create: { symbol: futTick.symbol, expiry: futTick.expiry || null, ltp: futTick.ltp, ts: futTick.ts as any },
          })
          .catch(() => {});
      } catch (e) {
        // ignore DB errors (non-blocking)
      }
      // also store in memory
      this.lastFutTick = futTick;
      return;
    }

    const payload = {
      symbol: meta.symbol,
      expiry: meta.expiry,
      strike: meta.strike,
      type: meta.optType as any,
      ltp,
      ts,
    };
    this.io.emit("oc:tick", payload);
  }

  private emitOi(meta: InstrMeta, oi: number, ts: number) {
    if (!Number.isFinite(oi) || oi < 0) return;
    if (!this.io) return;

    const payload: TickOI = {
      symbol: meta.symbol,
      expiry: meta.expiry,
      strike: meta.strike,
      type: meta.optType as any,
      oi,
      ts,
    };
    this.io.emit("oc:oi", payload);

    // Update PCR store and emit market:update when we have both sides
    const sym = String(meta.symbol || "NIFTY").toUpperCase();
    const exp = String(meta.expiry || "");
    if (!exp) return;
    const bucketKey = `${sym}|${exp}`;
    const b = this.oiByExpiry.get(bucketKey) || { ce: new Map(), pe: new Map() };
    if (meta.optType === "CE") b.ce.set(Number(meta.strike), oi);
    else if (meta.optType === "PE") b.pe.set(Number(meta.strike), oi);
    this.oiByExpiry.set(bucketKey, b);
    // Compute sums (could be optimized by incrementally adjusting)
    let sumCE = 0, sumPE = 0;
    for (const v of b.ce.values()) sumCE += Number(v) || 0;
    for (const v of b.pe.values()) sumPE += Number(v) || 0;
    if (sumCE > 0) {
      const pcr = sumPE / sumCE;
  const key = `${sym}|${exp}`;
  if (!this.pcrOpenByExpiry.has(key)) this.pcrOpenByExpiry.set(key, pcr);
      this.io.emit("market:update", { pcr });
    }
  }

  // expose current PCR for a given (symbol, expiry)
  public getPCR(symbol: string, expiry: string): number | undefined {
    const sym = String(symbol || "NIFTY").toUpperCase();
    const exp = String(expiry || "");
    if (!exp) return undefined;
    const b = this.oiByExpiry.get(`${sym}|${exp}`);
    if (!b) return undefined;
    let sumCE = 0, sumPE = 0;
    for (const v of b.ce.values()) sumCE += Number(v) || 0;
    for (const v of b.pe.values()) sumPE += Number(v) || 0;
    if (sumCE <= 0) return undefined;
    return sumPE / sumCE;
  }

  // expose PCR open (first computed of session) if available
  public getPCROpen(symbol: string, expiry: string): number | undefined {
    const sym = String(symbol || "NIFTY").toUpperCase();
    const exp = String(expiry || "");
    if (!exp) return undefined;
    return this.pcrOpenByExpiry.get(`${sym}|${exp}`);
  }
}

/* ---------------- singleton facade ---------------- */
let _feed: DhanFeed | null = null;

export async function initDhanFeed(io: Server) {
  if (_feed) return _feed;
  _feed = new DhanFeed(io);
  await _feed.init();
  return _feed;
}
export function wsSubscribeChain(symbol: string, expiry: string) {
  _feed?.subscribeChain(symbol, expiry);
}
export function wsUnsubscribeChain(symbol: string, expiry: string) {
  _feed?.unsubscribeChain(symbol, expiry);
}
export function getCurrentPCR(symbol: string, expiry: string): number | undefined {
  return _feed?.getPCR(symbol, expiry);
}
export function getPCROpen(symbol: string, expiry: string): number | undefined {
  return _feed?.getPCROpen(symbol, expiry);
}
