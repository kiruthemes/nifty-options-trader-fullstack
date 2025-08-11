import React, { useEffect, useMemo, useRef, useState } from "react";
import { bsPrice } from "../utils/bs.js";
import { DEFAULT_IV, DEFAULT_RF_RATE, DEFAULT_LOT_SIZE } from "../config.js";

/**
 * Props:
 *  - spot: number
 *  - futPrice?: number
 *  - rows: [{ strike, callLtp, putLtp, callOi, putOi, iv, deltaC, deltaP }] OR provider-shaped rows
 *  - expiries: [{ code,label }] | string[]
 *  - selectedExpiry: string
 *  - onSelectExpiry: (code) => void
 *  - onAddLeg: (side, type, strike, premium, expiry) => void
 *  - onTableWidthChange?: (px:number) => void
 *  - atmBasis?: "spot" | "futures"
 *  - onAtmBasisChange?: (basis: "spot"|"futures")
 */
export default function OptionChain({
  spot = 24350,
  futPrice,
  rows = [],
  expiries = [],
  selectedExpiry,
  onSelectExpiry,
  onAddLeg,
  onTableWidthChange,
  atmBasis: atmBasisProp,
  onAtmBasisChange,
}) {
  // ---------- Settings: ATM basis (controlled or local) ----------
  const [atmBasisLocal, setAtmBasisLocal] = useState(() => {
    try { return localStorage.getItem("atm.basis") || "spot"; } catch { return "spot"; }
  });
  const atmBasis = atmBasisProp ?? atmBasisLocal;
  const setAtmBasisBoth = (val) => {
    try { localStorage.setItem("atm.basis", val); } catch {}
    setAtmBasisLocal(val);
    onAtmBasisChange?.(val);
  };

  const [showSettings, setShowSettings] = useState(false);

  // normalize expiries
  const exps = (expiries || []).map((e) =>
    typeof e === "string" ? { code: String(e), label: e } : e
  );
  const activeCode = selectedExpiry || exps[0]?.code;

  // ----- derive numeric ref (spot/futures) -----
  const refPrice = useMemo(() => {
    const src = atmBasis === "futures" ? futPrice : spot;
    const n = Number(src);
    return Number.isFinite(n) ? n : undefined;
  }, [atmBasis, futPrice, spot]);

  // ----- numeric, sorted strikes -----
  const strikesSorted = useMemo(() => {
    const arr = rows.map((r) => Number(r.strike)).filter((n) => Number.isFinite(n));
    arr.sort((a, b) => a - b);
    return arr;
  }, [rows]);

  const minStrike = strikesSorted[0];
  const maxStrike = strikesSorted[strikesSorted.length - 1];

  // Robust ATM (closest strike; tie -> higher)
  const atmStrike = useMemo(() => {
    if (!strikesSorted.length) return undefined;
    if (!Number.isFinite(refPrice)) return strikesSorted[Math.floor(strikesSorted.length / 2)];
    let best = strikesSorted[0];
    let bestDiff = Math.abs(best - refPrice);
    for (let i = 1; i < strikesSorted.length; i++) {
      const s = strikesSorted[i];
      const d = Math.abs(s - refPrice);
      if (d < bestDiff || (d === bestDiff && s > best)) {
        best = s; bestDiff = d;
      }
    }
    return best;
  }, [strikesSorted, refPrice]);

  const callOiMax = useMemo(
    () => Math.max(...rows.map((r) => Number(r.callOi ?? r?.ce?.oi ?? r?.call?.oi) || 1), 1),
    [rows]
  );
  const putOiMax = useMemo(
    () => Math.max(...rows.map((r) => Number(r.putOi ?? r?.pe?.oi ?? r?.put?.oi) || 1), 1),
    [rows]
  );

  // --------- OI baseline per expiry (market-open snapshot) ---------
  const baselineRef = useRef({});
  useEffect(() => {
    if (!activeCode) return;
    if (!baselineRef.current[activeCode]) {
      const snap = {};
      for (const r of rows) {
        const k = Number(r.strike);
        if (Number.isFinite(k)) {
          const co = Number(r.callOi ?? r?.ce?.oi ?? r?.call?.oi) || 0;
          const po = Number(r.putOi ?? r?.pe?.oi ?? r?.put?.oi) || 0;
          snap[k] = { callOi: co, putOi: po };
        }
      }
      baselineRef.current[activeCode] = snap;
    }
  }, [activeCode, rows]);

  const baseFor = (strike) =>
    baselineRef.current[activeCode]?.[Number(strike)] || { callOi: 0, putOi: 0 };

  // --------- Auto-center ATM on load/changes ---------
  const scrollerRef = useRef(null);
  const atmRowRef = useRef(null);
  useEffect(() => {
    const centerATM = () => {
      const container = scrollerRef.current;
      const row = atmRowRef.current;
      if (!container || !row) return;

      const cRect = container.getBoundingClientRect();
      const rRect = row.getBoundingClientRect();
      const delta = (rRect.top - cRect.top) - (cRect.height / 2 - rRect.height / 2);

      container.scrollTo({ top: container.scrollTop + delta, behavior: "smooth" });
    };
    const rafId = typeof requestAnimationFrame !== "undefined" ? requestAnimationFrame(centerATM) : null;
    const t = setTimeout(centerATM, 0);
    return () => { if (rafId) cancelAnimationFrame(rafId); clearTimeout(t); };
  }, [atmStrike, activeCode, rows.length]);

  // --------- Measure full table width (report to parent) ---------
  const tableRef = useRef(null);
  useEffect(() => {
    if (!onTableWidthChange) return;
    const el = tableRef.current;
    if (!el) return;

    const report = () => {
      const w = Math.ceil(el.scrollWidth + 24);
      onTableWidthChange(w);
    };

    report();
    let ro = null;
    if (typeof ResizeObserver !== "undefined") {
      ro = new ResizeObserver(report);
      try { ro.observe(el); } catch {}
    }
    const onWin = () => report();
    if (typeof window !== "undefined") window.addEventListener("resize", onWin);
    const int = setInterval(report, 500);

    return () => {
      if (ro) ro.disconnect();
      if (typeof window !== "undefined") window.removeEventListener("resize", onWin);
      clearInterval(int);
    };
  }, [onTableWidthChange, rows, activeCode, atmBasis]);

  // --------- Provider-agnostic accessors + fallback ---------
  const ltpFor = (row, type /* "CE"|"PE" */) => {
    const raw =
      type === "CE"
        ? (row.callLtp ?? row?.ce?.ltp ?? row?.call?.ltp)
        : (row.putLtp ?? row?.pe?.ltp ?? row?.put?.ltp);
    return Number(raw);
  };
  const oiFor = (row, type) => {
    const raw =
      type === "CE"
        ? (row.callOi ?? row?.ce?.oi ?? row?.call?.oi)
        : (row.putOi ?? row?.pe?.oi ?? row?.put?.oi);
    return Number(raw);
  };
  const bsFallback = (strike, type) => {
    const t = Math.max(1 / 365, 5 / 365); // rough
    const underlying = Number.isFinite(spot) ? spot : (refPrice || spot || strike);
    const optType = type === "CE" ? "C" : "P";
    return +bsPrice(underlying, strike, DEFAULT_RF_RATE, DEFAULT_IV, t, optType).toFixed(2);
  };
  const premiumFor = (row, strike, type) => {
    const ltp = ltpFor(row, type);
    return Number.isFinite(ltp) && ltp > 0 ? ltp : bsFallback(strike, type);
  };

  return (
    <aside className="card h-[calc(100vh-24px)] sticky top-3 p-0 overflow-hidden">
      {/* Header */}
      <div className="px-4 pt-3">
        <div className="flex items-center justify-between gap-2">
          <div className="text-[15px] font-semibold">Option Chain</div>

          {/* ATM chip + ref */}
          <div className="ml-auto flex items-center gap-2">
            <span className="px-2 py-0.5 rounded-full text-xs bg-blue-50 text-blue-700 dark:bg-blue-900/30 dark:text-blue-200 border border-blue-200 dark:border-blue-800">
              ATM: <b>{atmStrike ?? "—"}</b>
            </span>
            <span className="px-2 py-0.5 rounded-full text-xs bg-gray-100 text-gray-700 dark:bg-blue-gray-800 dark:text-blue-gray-200 border border-gray-200 dark:border-blue-gray-700">
              Basis: <b>{atmBasis === "futures" ? "FUT" : "SPOT"}</b> • ₹{" "}
              {Number.isFinite(refPrice) ? refPrice.toLocaleString("en-IN") : "—"}
            </span>
            {Number.isFinite(refPrice) && (refPrice < minStrike || refPrice > maxStrike) && (
              <span className="px-2 py-0.5 rounded-full text-xs bg-amber-100 text-amber-800 border border-amber-200">
                Ref outside chain ({minStrike}–{maxStrike})
              </span>
            )}
            {/* settings button */}
            <button
              className="px-2 py-1 rounded-lg border dark:border-blue-gray-700 hover:bg-gray-50 dark:hover:bg-blue-gray-800"
              title="Chain settings"
              onClick={() => setShowSettings((s) => !s)}
            >
              <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor">
                <path strokeWidth="2" d="M12 15a3 3 0 100-6 3 3 0 000 6z"/>
                <path strokeWidth="2" d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 11-2.83 2.83l-.06-.06A1.65 1.65 0 0015 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 112.83-2.83l.06-.06A1.65 1.65 0 0019.4 15z"/>
              </svg>
            </button>
          </div>
        </div>

        {/* Settings popover */}
        {showSettings && (
          <div className="mt-2 p-3 rounded-xl border dark:border-blue-gray-700 bg-white dark:bg-blue-gray-900 shadow">
            <div className="text-xs muted mb-1">ATM Basis</div>
            <div className="flex items-center gap-3 text-sm">
              <label className="inline-flex items-center gap-2 cursor-pointer">
                <input
                  type="radio"
                  className="accent-blue-600"
                  checked={atmBasis === "spot"}
                  onChange={() => setAtmBasisBoth("spot")}
                />
                <span>Spot (₹ {Number(spot).toLocaleString("en-IN")})</span>
              </label>
              <label className="inline-flex items-center gap-2 cursor-pointer">
                <input
                  type="radio"
                  className="accent-blue-600"
                  checked={atmBasis === "futures"}
                  onChange={() => setAtmBasisBoth("futures")}
                />
                <span>
                  Futures (₹ {Number.isFinite(Number(futPrice)) ? Number(futPrice).toLocaleString("en-IN") : "—"})
                </span>
              </label>
            </div>
          </div>
        )}

        {/* Expiry scroller */}
        <div className="mt-2 flex items-center gap-2 text-sm overflow-x-auto no-scrollbar">
          {(expiries || []).map((x) => {
            const item = typeof x === "string" ? { code: x, label: x } : x;
            const active = activeCode === item.code;
            return (
              <button
                key={item.code}
                className={`px-3 py-1 rounded-full border dark:border-blue-gray-700 whitespace-nowrap ${
                  active
                    ? "bg-blue-50 text-blue-700 dark:bg-blue-gray-800"
                    : "hover:bg-gray-50 dark:hover:bg-blue-gray-800"
                }`}
                onClick={() => onSelectExpiry?.(item.code)}
              >
                {item.label}
              </button>
            );
          })}
          <span className="ml-auto muted whitespace-nowrap">
            Lot Size: <b>{DEFAULT_LOT_SIZE}</b>
          </span>
        </div>
      </div>

      {/* Table */}
      <div className="mt-3 h-[calc(100%-92px)] overflow-y-auto" ref={scrollerRef}>
        <table ref={tableRef} className="w-full">
          <thead className="sticky top-0 bg-white dark:bg-blue-gray-900 z-10">
            <tr className="oc-head">
              <th className="pl-4 w-[64px]">Delta</th>
              <th className="w-[90px]">Call LTP</th>
              <th className="w-[200px]">OI (Δ)</th>
              <th className="text-center w-[120px] oc-sep">Strike</th>
              <th className="w-[60px] oc-sep">IV</th>
              <th className="w-[200px]">OI (Δ)</th>
              <th className="w-[90px]">Put LTP</th>
              <th className="text-right pr-4 w-[64px]">Delta</th>
            </tr>
          </thead>

          <tbody className="divide-y divide-blue-gray-50 dark:divide-blue-gray-800">
            {rows.map((r) => {
              const strikeN = Number(r.strike);
              const isATM = Number.isFinite(strikeN) && atmStrike === strikeN;

              const refVal = refPrice;
              const callITM = Number.isFinite(refVal) && strikeN < refVal;
              const putITM  = Number.isFinite(refVal) && strikeN > refVal;

              const base = baseFor(strikeN);
              const callOiVal = oiFor(r, "CE");
              const putOiVal  = oiFor(r, "PE");
              const callDelta = (callOiVal || 0) - (Number(base.callOi) || 0);
              const putDelta  = (putOiVal  || 0) - (Number(base.putOi)  || 0);

              const callLtp = ltpFor(r, "CE");
              const putLtp  = ltpFor(r, "PE");

              return (
                <tr
                  key={strikeN}
                  ref={isATM ? atmRowRef : null}
                  className={`group oc-row ${isATM ? "bg-blue-50/80 dark:bg-blue-900/30" : ""}`}
                >
                  {/* Call side */}
                  <td className={`pl-4 relative ${callITM ? "oc-itm" : ""} ${isATM ? "atm-stripe" : ""}`}>
                    {to2(r.deltaC)}
                  </td>
                  <td className={`font-semibold ${callITM ? "oc-itm" : ""}`}>{to2(callLtp)}</td>
                  <td className={`${callITM ? "oc-itm" : ""}`}>
                    <OIBar side="call" value={callOiVal} base={Number(base.callOi)} max={callOiMax} />
                    <DeltaBadge v={callDelta} />
                  </td>

                  {/* Strike + actions */}
                  <td className="text-center font-bold oc-sep relative">
                    <div className="inline-flex items-center gap-2 relative">
                      <span>{strikeN}</span>
                      {isATM && (
                        <span className="px-2 py-0.5 text-[10px] rounded-full bg-blue-600 text-white shadow">
                          ATM
                        </span>
                      )}

                      {/* CE actions (left) */}
                      <div className="oc-actions -left-24 top-1/2 -translate-y-1/2">
                        <button
                          className="oc-pill oc-btn-left bg-green-600"
                          onClick={() => onAddLeg?.("BUY", "CE", strikeN, premiumFor(r, strikeN, "CE"), activeCode)}
                        >
                          Buy CE
                        </button>
                        <button
                          className="oc-pill oc-btn-right bg-red-600"
                          onClick={() => onAddLeg?.("SELL", "CE", strikeN, premiumFor(r, strikeN, "CE"), activeCode)}
                        >
                          Sell CE
                        </button>
                      </div>

                      {/* PE actions (right) */}
                      <div className="oc-actions -right-24 top-1/2 -translate-y-1/2">
                        <button
                          className="oc-pill oc-btn-left bg-green-600"
                          onClick={() => onAddLeg?.("BUY", "PE", strikeN, premiumFor(r, strikeN, "PE"), activeCode)}
                        >
                          Buy PE
                        </button>
                        <button
                          className="oc-pill oc-btn-right bg-red-600"
                          onClick={() => onAddLeg?.("SELL", "PE", strikeN, premiumFor(r, strikeN, "PE"), activeCode)}
                        >
                          Sell PE
                        </button>
                      </div>
                    </div>
                  </td>

                  {/* Put side */}
                  <td className={`oc-sep ${putITM ? "oc-itm" : ""}`}>{to1(r.iv)}</td>
                  <td className={`${putITM ? "oc-itm" : ""}`}>
                    <OIBar side="put" value={putOiVal} base={Number(base.putOi)} max={putOiMax} />
                    <DeltaBadge v={putDelta} />
                  </td>
                  <td className={`font-semibold ${putITM ? "oc-itm" : ""}`}>{to2(putLtp)}</td>
                  <td className={`text-right pr-4 ${putITM ? "oc-itm" : ""}`}>{to2(r.deltaP)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </aside>
  );
}

/* -------- helpers -------- */
function to2(n) { const v = Number(n); return Number.isFinite(v) ? v.toFixed(2) : "0.00"; }
function to1(n) { const v = Number(n); return Number.isFinite(v) ? v.toFixed(1) : "0.0"; }
function pct(v, max) { return Math.max(6, Math.min(100, Math.round(((Number(v) || 0) / Math.max(1, Number(max) || 1)) * 100))); }

function OIBar({ value = 0, base = 0, max = 1, side = "call" }) {
  const wBase = pct(base, max);
  const wNow  = pct(value, max);
  const light = side === "call" ? "bg-blue-300" : "bg-orange-300";
  const dark  = side === "call" ? "bg-blue-600" : "bg-orange-600";
  return (
    <div className="relative oc-oi" title={`OI: ${formatInt(value)} | Δ ${formatInt((value || 0) - (base || 0))}`}>
      <span className={`absolute left-0 top-0 h-2 ${light} rounded`} style={{ width: `${wBase}%` }} />
      <span className={`absolute left-0 top-0 h-2 ${dark}  rounded`} style={{ width: `${wNow }%` }} />
    </div>
  );
}

function DeltaBadge({ v = 0 }) {
  const n = Number(v) || 0;
  if (!n) return <div className="text-[11px] muted mt-1">Δ 0</div>;
  const cls = n > 0 ? "text-emerald-600" : "text-red-600";
  const sign = n > 0 ? "+" : "";
  return <div className={`text-[11px] mt-1 ${cls}`}>Δ {sign}{formatInt(n)}</div>;
}
function formatInt(n) { return Math.round(Number(n) || 0).toLocaleString("en-IN"); }
