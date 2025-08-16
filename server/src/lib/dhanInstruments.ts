// server/src/lib/dhanInstruments.ts
import fs from "fs";
import path from "path";

/**
 * Lightweight CSV -> instrument maps for Dhan instruments (NSE only).
 * Uses the same column logic as ws/dhanFeed.ts:
 *   EXCH_ID="NSE", SEGMENT="D" (F&O) or "I" (INDEX),
 *   INSTRUMENT="FUTIDX"/"OPTIDX" (or FUTSTK/OPTSTK),
 *   INSTRUMENT_TYPE="FUT" for futures,
 *   SM_EXPIRY_DATE in DD/MM/YY or DD/MM/YYYY.
 */

export type ExchReq = "NSE_FNO" | "NSE_INDEX" | "NSE_EQ";

type CsvRow = Record<string, string>;

export type InstrMeta = {
  secId: string;                 // SecurityId
  exch: ExchReq;                 // NSE_FNO | NSE_INDEX | NSE_EQ
  symbol?: string;               // NIFTY, BANKNIFTY, etc.
  expiry?: string;               // YYYY-MM-DD for F&O
  strike?: number;
  optType?: "CE" | "PE";
  isIndex?: boolean;             // spot index
  isFut?: boolean;               // futures
  tsym?: string;                 // trading symbol if present
};

function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "", q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (q && line[i + 1] === '"') { cur += '"'; i++; }
      else { q = !q; }
    } else if (ch === "," && !q) {
      out.push(cur); cur = "";
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
    headers.forEach((h, i) => { obj[h] = (cols[i] ?? "").trim(); obj[h.toLowerCase()] = obj[h]; });
    rows.push(obj);
  }
  return rows;
}

function get(obj: CsvRow, ...keys: string[]): string {
  for (const k of keys) {
    for (const v of [k, k.toLowerCase(), k.toUpperCase()]) {
      if (obj[v] != null && obj[v] !== "") return obj[v];
    }
  }
  return "";
}

// Parse Dhan’s SM_EXPIRY_DATE etc. (YYYY-MM-DD or DD/MM/YY or DD/MM/YYYY)
function parseDhanExpiry(s: string): string | undefined {
  const v = (s || "").trim();
  if (!v) return undefined;
  if (/^\d{4}-\d{2}-\d{2}/.test(v)) return v.slice(0, 10);
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/.exec(v);
  if (m) {
    let dd = Number(m[1]), mm = Number(m[2]), yy = Number(m[3]);
    if (yy < 100) yy += 2000;
    const d = new Date(Date.UTC(yy, mm - 1, dd));
    return d.toISOString().slice(0, 10);
  }
  // As a last resort, avoid locale-dependent Date() parsing here.
  return undefined;
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

export function loadDhanInstrumentMaps(csvPath: string): {
  bySecId: Map<string, InstrMeta>;
  chainIndex: Map<string, string[]>;   // key: "SYMBOL|YYYY-MM-DD" -> [secId...]
  idxSpot: Map<string, string>;        // "NIFTY" -> index secId
  idxFut: Map<string, string>;         // "NIFTY" -> nearest monthly FUT secId
} {
  const rows = slurpCsv(csvPath);
  const bySecId = new Map<string, InstrMeta>();
  const chainIndex = new Map<string, string[]>();
  const idxSpot = new Map<string, string>();
  const idxFut  = new Map<string, string>();

  const today = new Date(); today.setHours(0,0,0,0);

  for (const r of rows) {
    const exchId = (get(r, "EXCH_ID") || "").toUpperCase();      // "NSE"
    const segment = (get(r, "SEGMENT") || "").toUpperCase();     // "D" (Derivatives) or "I" (Index)
    const instrument = (get(r, "INSTRUMENT") || "").toUpperCase();          // "FUTIDX"/"OPTIDX"/...
    const instrumentType = (get(r, "INSTRUMENT_TYPE") || "").toUpperCase(); // "FUT" for futures

    // Exchange segment mapping we care about
    let exch: ExchReq | undefined;
    if (exchId === "NSE" && segment === "I") exch = "NSE_INDEX";
    else if (exchId === "NSE" && segment === "D") exch = "NSE_FNO";
    else continue; // ignore everything else

    const secId = get(r, "SECURITY_ID");
    if (!secId) continue;

    // Symbol: prefer UNDERLYING_SYMBOL; fall back to SYMBOL_NAME/DISPLAY_NAME
    const symRaw = get(r, "UNDERLYING_SYMBOL", "SYMBOL_NAME", "DISPLAY_NAME");
    const symbol = normalizeSymbol(symRaw);
    if (!symbol) continue;

    // Expiry / strike / option type
    const expiry = parseDhanExpiry(get(r, "SM_EXPIRY_DATE", "EXPIRY_DATE", "expiry"));
    const strike = toNum(get(r, "STRIKE_PRICE"));
    const optTypeRaw = (get(r, "OPTION_TYPE") || "").toUpperCase();
    const optType: "CE" | "PE" | undefined = optTypeRaw === "CE" || optTypeRaw === "PE" ? (optTypeRaw as any) : undefined;

    const tsym = get(r, "SYMBOL_NAME", "DISPLAY_NAME");

  const isIndex = exch === "NSE_INDEX" || instrument === "INDEX";
  // Options detection: accept OPTIDX/OPTSTK rows when exchange is NSE_FNO.
  // Some CSV rows use INSTRUMENT_TYPE 'OP' so avoid relying on instrumentType value.
  const isOpt   = exch === "NSE_FNO" && (instrument === "OPTIDX" || instrument === "OPTSTK");
  const isFut   = exch === "NSE_FNO" && instrument === "FUTIDX" && instrumentType === "FUT";

    const meta: InstrMeta = {
      secId, exch, symbol, expiry, strike, optType, isIndex, isFut, tsym,
    };
    bySecId.set(secId, meta);

    // Index spot map
    if (isIndex) {
      if (symbol.includes("NIFTY")) idxSpot.set("NIFTY", secId);
      if (symbol.includes("BANK"))  idxSpot.set("BANKNIFTY", secId);
    }

    // Options chain index
    if (isOpt && expiry && typeof strike === "number" && (optType === "CE" || optType === "PE")) {
      const key = `${symbol}|${expiry}`;
      const arr = chainIndex.get(key) || [];
      arr.push(secId);
      chainIndex.set(key, arr);
    }

    // Futures: pick nearest monthly >= today
    if (isFut && expiry) {
      const prev = idxFut.get(symbol);
      if (!prev) {
        idxFut.set(symbol, secId);
      } else {
        const curMeta = bySecId.get(prev);
        const dPrev = curMeta?.expiry ? new Date(curMeta.expiry + "T00:00:00Z") : undefined;
        const dThis = new Date(expiry + "T00:00:00Z");
        if (dThis >= today && (!dPrev || dPrev < today || dThis < dPrev)) {
          idxFut.set(symbol, secId);
        }
      }
    }
  }

  // Environment overrides for cases where CSV is incomplete or from a different exchange
  // These ensure we can still resolve critical securityIds without depending on CSV rows.
  try {
    const envNifty = (process.env.DHAN_NIFTY_SID || "").trim();
    const envBank  = (process.env.DHAN_BANKNIFTY_SID || "").trim();
    const envVix   = (process.env.DHAN_INDIAVIX_SID || process.env.DHAN_VIX_SID || "").trim();
    const envNiftyFut = (process.env.DHAN_NIFTY_FUT_SID || "").trim();
    const envBankFut  = (process.env.DHAN_BANKNIFTY_FUT_SID || "").trim();

    if (envNifty) {
      idxSpot.set("NIFTY", envNifty);
      if (!bySecId.has(envNifty))
        bySecId.set(envNifty, { secId: envNifty, exch: "NSE_INDEX", symbol: "NIFTY", isIndex: true });
    }
    if (envBank) {
      idxSpot.set("BANKNIFTY", envBank);
      if (!bySecId.has(envBank))
        bySecId.set(envBank, { secId: envBank, exch: "NSE_INDEX", symbol: "BANKNIFTY", isIndex: true });
    }
    if (envVix) {
      idxSpot.set("INDIAVIX", envVix);
      if (!bySecId.has(envVix))
        bySecId.set(envVix, { secId: envVix, exch: "NSE_INDEX", symbol: "INDIAVIX", isIndex: true });
    }
    if (envNiftyFut) {
      idxFut.set("NIFTY", envNiftyFut);
      if (!bySecId.has(envNiftyFut))
        bySecId.set(envNiftyFut, { secId: envNiftyFut, exch: "NSE_FNO", symbol: "NIFTY", isFut: true });
    }
    if (envBankFut) {
      idxFut.set("BANKNIFTY", envBankFut);
      if (!bySecId.has(envBankFut))
        bySecId.set(envBankFut, { secId: envBankFut, exch: "NSE_FNO", symbol: "BANKNIFTY", isFut: true });
    }
  } catch {}

  return { bySecId, chainIndex, idxSpot, idxFut };
}
