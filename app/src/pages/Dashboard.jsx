// app/src/pages/Dashboard.jsx
import React, { useEffect, useRef, useState } from "react";
import PayoffPanel from "../components/PayoffPanel.jsx";
import PositionsList, { ExecutedOrders } from "../components/PositionsList.jsx";
import OptionChain from "../components/OptionChain.jsx";
import useSocket from "../hooks/useSocket.js";
import { bsPrice } from "../utils/bs.js";
import { DEFAULT_LOT_SIZE, DEFAULT_RF_RATE, DEFAULT_IV } from "../config.js";
import { placeOrdersForStrategy, getProvider, fetchOptionChain, getExpiries } from "../utils/api.js";
import * as StrategyStore from "../utils/strategyStore.js";

console.log("%cDashboard v14 (WS ticks + REST 3/5min + live greeks/ATM)", "color:#0ea5e9");

const MS_3MIN = 3 * 60 * 1000;
const MS_5MIN = 5 * 60 * 1000;

/* ------- small BS helpers for delta using last REST IV ------- */
function normCdf(x) {
  const a1 = 0.31938153, a2 = -0.356563782, a3 = 1.781477937, a4 = -1.821255978, a5 = 1.330274429;
  const L = Math.abs(x);
  const k = 1.0 / (1.0 + 0.2316419 * L);
  const w = 1.0 - 0.3989422804014327 * Math.exp((-L * L) / 2) * ((((a5 * k + a4) * k + a3) * k + a2) * k + a1) * k;
  return x < 0 ? 1.0 - w : w;
}
function toIvDecimal(iv) {
  const v = Number(iv);
  return !Number.isFinite(v) || v <= 0 ? 0.12 : v > 1 ? v / 100 : v;
}
function yearsTo(expiryCode) {
  if (!expiryCode) return 1 / 365;
  const d = new Date(expiryCode + "T00:00:00");
  const now = new Date(); now.setHours(0, 0, 0, 0);
  const days = Math.max(1, Math.round((d - now) / (24 * 3600 * 1000)));
  return days / 365;
}
function deltaFor(S, K, r, ivDec, T, type /* "CE"|"PE" */) {
  if (!Number.isFinite(S) || !Number.isFinite(K) || !Number.isFinite(T) || T <= 0) return 0;
  const sigma = Math.max(1e-6, ivDec);
  const d1 = (Math.log(S / K) + (r + 0.5 * sigma * sigma) * T) / (sigma * Math.sqrt(T));
  const Nd1 = normCdf(d1);
  return type === "CE" ? Nd1 : Nd1 - 1;
}

export default function Dashboard() {
  // underlying symbol
  const [underlying, setUnderlying] = useState(() => {
    try { return localStorage.getItem("ui.underlying") || "NIFTY"; } catch { return "NIFTY"; }
  });
  useEffect(() => {
    const onU = (e) => setUnderlying(e.detail || "NIFTY");
    window.addEventListener("ui:underlying-change", onU);
    return () => window.removeEventListener("ui:underlying-change", onU);
  }, []);

  // expiries
  const [selectedExpiry, setSelectedExpiry] = useState(null);
  const [expiries, setExpiries] = useState([]);
  useEffect(() => {
    (async () => {
      try {
        const { expiries: list } = await getExpiries(underlying);
        const items = (list || []).map((code) => {
          const d = new Date(code + "T00:00:00");
          const base = new Date(); base.setHours(0, 0, 0, 0);
          const days = Math.max(0, Math.ceil((d - base) / (24 * 60 * 60 * 1000)));
          const dd = d.toLocaleDateString("en-GB", { day: "2-digit" });
          const mon = d.toLocaleDateString("en-GB", { month: "short" }).toUpperCase();
          return { code, label: `${dd} ${mon} (${days}d)`, days };
        });
        setExpiries(items);
        setSelectedExpiry((cur) => (cur && items.find((x) => x.code === cur)) ? cur : items[0]?.code || null);
      } catch (e) {
        console.warn("[EXPIRIES] failed", e?.message || e);
        setExpiries([]); setSelectedExpiry(null);
      }
    })();
  }, [underlying]);

  // live WS feed (spot/fut + per-strike maps). Debounced oc:select happens inside hook.
  const { spot: spotWs, fut: futWs, ltpMap, oiMap, status: feedStatus } =
    useSocket({ symbol: underlying, expiry: selectedExpiry, debounceMs: 200 });

  // provider (for banners)
  const [provider, setProvider] = useState("dhan");
  useEffect(() => {
    (async () => { try { setProvider(await getProvider()); } catch { setProvider("dhan"); } })();
    const onProv = (e) => setProvider(e.detail);
    window.addEventListener("provider:change", onProv);
    return () => window.removeEventListener("provider:change", onProv);
  }, []);

  // REST snapshot rows (IV + initial OI/LTP) refreshed 3/5 min
  const [baseRows, setBaseRows] = useState([]);
  const [spotApi, setSpotApi] = useState(undefined);
  const [futApi, setFutApi] = useState(undefined);
  const [pcr, setPcr] = useState(undefined);
  const [pcrOpen, setPcrOpen] = useState(undefined);
  useEffect(() => {
    if (!selectedExpiry) return;
    let cancelled = false;
    let int3 = null, int5 = null;

    const load = async () => {
      try {
        const snap = await fetchOptionChain(underlying, selectedExpiry);
        if (cancelled) return;
        const rows = Array.isArray(snap?.rows) ? snap.rows : [];
        setBaseRows(rows);

  // index last price (spot)
        if (Number.isFinite(Number(snap?.lastPrice))) setSpotApi(Number(snap.lastPrice));
        // optional futures close if attached by server
        if (Number.isFinite(Number(snap?.futClose))) setFutApi(Number(snap.futClose));
        else setFutApi(undefined);
  // PCR (if backend provided via hydration elsewhere, keep it in a small poll or event)
      } catch (e) {
        if (!cancelled) setBaseRows([]);
        console.warn("[OC] fetchOptionChain failed", e?.message || e);
      }
    };

    load(); // initial
    int3 = setInterval(load, MS_3MIN); // IV/greeks refresh cadence
    int5 = setInterval(load, MS_5MIN); // OI resync cadence

    return () => { cancelled = true; if (int3) clearInterval(int3); if (int5) clearInterval(int5); };
  }, [underlying, selectedExpiry]);

  // ATM basis & reference prices (WS first, then API fallback)
  const [atmBasis, setAtmBasis] = useState(() => localStorage.getItem("atm.basis") || "spot");
  useEffect(() => { localStorage.setItem("atm.basis", atmBasis); }, [atmBasis]);

  const uiSpot = Number.isFinite(spotWs) ? spotWs : (Number.isFinite(spotApi) ? spotApi : undefined);
  const uiFut  = Number.isFinite(futWs)  ? futWs  : (Number.isFinite(futApi)  ? futApi  : undefined);
  
  // Listen to market:update to capture PCR (computed from WS or fallback from OC)
  useEffect(() => {
    const onMarket = (e) => {
      const d = e.detail || {};
      if (Number.isFinite(Number(d.pcr))) setPcr(Number(d.pcr));
      if (Number.isFinite(Number(d.pcrOpen))) setPcrOpen(Number(d.pcrOpen));
    };
    window.addEventListener("market:update", onMarket);
    return () => window.removeEventListener("market:update", onMarket);
  }, []);

  // Merge REST rows with WS ticks (compute fresh each render)
  const mergedRows = (() => {
    if (!Array.isArray(baseRows) || !baseRows.length) return [];
    const ref = atmBasis === "futures" ? uiFut : uiSpot;
    const T = yearsTo(selectedExpiry);
    const out = [];
    for (const r of baseRows) {
      const kCE = `${Number(r.strike)}|CE`;
      const kPE = `${Number(r.strike)}|PE`;

      const callLtp = Number.isFinite(ltpMap?.get?.(kCE)) ? ltpMap.get(kCE) : Number(r.callLtp);
      const putLtp  = Number.isFinite(ltpMap?.get?.(kPE)) ? ltpMap.get(kPE) : Number(r.putLtp);
      const callOi  = Number.isFinite(oiMap?.get?.(kCE)) ? oiMap.get(kCE) : Number(r.callOi || 0);
      const putOi   = Number.isFinite(oiMap?.get?.(kPE)) ? oiMap.get(kPE) : Number(r.putOi || 0);

      const ivDec = toIvDecimal(r.iv);
      const dC = Number.isFinite(ref)
        ? deltaFor(ref, Number(r.strike), DEFAULT_RF_RATE, ivDec, T, "CE")
        : (Number(r.deltaC) || 0);
      const dP = dC - 1;

      out.push({ ...r, callLtp, putLtp, callOi, putOi, deltaC: +dC.toFixed(2), deltaP: +dP.toFixed(2) });
    }
    return out;
  })();

  // ----- resizable OC pane -----
  const containerRef = useRef(null);
  const GAP_PX = 12, HANDLE_PX = 6, minW = 360;
  const [ocWidth, setOcWidth] = useState(() => Number(localStorage.getItem("oc.width.px")) || 420);
  const [ocCollapsed, setOcCollapsed] = useState(() => localStorage.getItem("oc.collapsed") === "1");
  const [tableWidth, setTableWidth] = useState(700);
  const [isXL, setIsXL] = useState(() => (typeof window !== "undefined" ? window.innerWidth >= 1280 : true));
  useEffect(() => {
    const onResize = () => setIsXL(window.innerWidth >= 1280);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  const getContainerWidth = () => (containerRef.current ? containerRef.current.clientWidth : 1200);
  const getMaxWidth = () => Math.max(minW, getContainerWidth() - HANDLE_PX - GAP_PX);
  useEffect(() => { localStorage.setItem("oc.width.px", String(ocWidth)); }, [ocWidth]);
  useEffect(() => { localStorage.setItem("oc.collapsed", ocCollapsed ? "1" : "0"); }, [ocCollapsed]);
  useEffect(() => {
    const clamp = () => { if (!ocCollapsed) setOcWidth((w) => Math.min(w, getMaxWidth())); };
    window.addEventListener("resize", clamp);
    return () => window.removeEventListener("resize", clamp);
  }, [ocCollapsed]);
  const startDrag = (e) => {
    if (!isXL) return;
    if (ocCollapsed) { setOcCollapsed(false); setOcWidth(minW); }
    const startX = e.clientX, startW = ocWidth;
    const onMove = (ev) => {
      const dx = ev.clientX - startX;
      const next = Math.max(minW, Math.min(getMaxWidth(), startW + dx));
      setOcWidth(next);
    };
    const onUp = () => {
      document.body.classList.remove("resizing");
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    document.body.classList.add("resizing");
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };
  const handleDoubleClick = () => {
    if (ocCollapsed) {
      setOcCollapsed(false);
      setOcWidth(Math.min(getMaxWidth(), Math.ceil(tableWidth || getMaxWidth())));
    } else {
      setOcCollapsed(true);
    }
  };

  // ---------------- Strategy state ----------------
  const [strategyId, setStrategyId] = useState(null);
  const [defaultLots, setDefaultLots] = useState(1);
  const [liveLegs, setLiveLegs] = useState([]);
  const [stagedLegs, setStagedLegs] = useState([]);
  const [realized, setRealized] = useState(0);

  const loadStrategyState = async (id) => {
    const sid = id || (await StrategyStore.getCurrentIdAsync());
    if (!sid) return;
    const st = await StrategyStore.loadStateAsync(sid);
    setStrategyId(sid);
    setLiveLegs(st?.liveLegs ?? []);
    setStagedLegs(st?.stagedLegs ?? []);
    setRealized(st?.realized ?? 0);
    setDefaultLots(st?.defaultLots ?? 1);

    if (st?.atmBasis) setAtmBasis(st.atmBasis);
    if (st?.underlying) {
      try { localStorage.setItem("ui.underlying", st.underlying); } catch {}
      window.dispatchEvent(new CustomEvent("ui:underlying-change", { detail: st.underlying }));
    }
    if (st?.selectedExpiry) setSelectedExpiry(st.selectedExpiry);
  };

  useEffect(() => {
    (async () => {
      const id = await StrategyStore.getCurrentIdAsync();
      if (id) await loadStrategyState(id);
      else { setStrategyId(null); setLiveLegs([]); setStagedLegs([]); setRealized(0); }
    })();
  }, []);

  useEffect(() => {
    if (!strategyId) return;
    StrategyStore.saveState(strategyId, { defaultLots, atmBasis, selectedExpiry, underlying });
  }, [strategyId, defaultLots, atmBasis, selectedExpiry, underlying]);

  useEffect(() => {
    const onSelected = async (e) => { await loadStrategyState(String(e.detail)); };
    const onSwitch   = async (e) => { await loadStrategyState(String(e.detail?.id)); };
    window.addEventListener("strategy:selected", onSelected);
    window.addEventListener("strategy:switch", onSwitch);
    return () => {
      window.removeEventListener("strategy:selected", onSelected);
      window.removeEventListener("strategy:switch", onSwitch);
    };
  }, []);

  useEffect(() => {
    const onLogin = async () => {
      let id = await StrategyStore.getCurrentIdAsync();
      if (!id) { id = await StrategyStore.createAsync("My First Strategy"); await StrategyStore.setCurrentIdAsync(id); }
      await loadStrategyState(id);
    };
    const onLogout = () => { setStrategyId(null); setLiveLegs([]); setStagedLegs([]); setRealized(0); };
    window.addEventListener("auth:login", onLogin);
    window.addEventListener("auth:logout", onLogout);
    return () => {
      window.removeEventListener("auth:login", onLogin);
      window.removeEventListener("auth:logout", onLogout);
    };
  }, []);

  useEffect(() => {
    const onClear = () => { setStrategyId(null); setLiveLegs([]); setStagedLegs([]); setRealized(0); };
    window.addEventListener("strategy:clear", onClear);
    window.addEventListener("strategy:reset", onClear);
    return () => {
      window.removeEventListener("strategy:clear", onClear);
      window.removeEventListener("strategy:reset", onClear);
    };
  }, []);

  // -------- staging & positions (use WS/API spot for pricing) --------
  const [daysToExpiry] = useState(5);
  const t = Math.max(1 / 365, daysToExpiry / 365);
  const nowSpotForPricing = Number.isFinite(uiSpot) ? uiSpot : 24400;

  const nowPrice = (leg) => {
    const type = leg.type === "CE" ? "C" : "P";
    return bsPrice(nowSpotForPricing, leg.strike, DEFAULT_RF_RATE, DEFAULT_IV, t, type);
  };

  const mkOrderFromLeg = (leg, action = "OPEN") => ({
    symbol: underlying,
    exchange: "NFO",
    product: "NRML",
    order_type: String(leg.order_type || "MARKET").toUpperCase(),
    side: leg.side,
    option_type: leg.type,
    strike: leg.strike,
    price: String(leg.order_type || "MARKET").toUpperCase() === "LIMIT" ? Number(leg.limit_price || nowPrice(leg)) : nowPrice(leg),
    lots: leg.lots || 1,
    lot_size: DEFAULT_LOT_SIZE,
    expiry: leg.expiry,
    expiryDate: leg.expiry,
    action,
  });

  const stageLeg = async (side, type, strike, premium, expiry) => {
    const leg = { side, type, strike, premium, lots: 1, expiry, status: "STAGED" };
    setStagedLegs((s) => [...s, leg]);
    const sid = strategyId;
    if (!sid) return;
    try {
      const created = await StrategyStore.createLeg(sid, leg);
      if (created?.id) {
        setStagedLegs((prev) => {
          const copy = [...prev];
          const idx = copy.findIndex((x) =>
            x === leg ||
            (x.side === leg.side && x.type === leg.type && x.strike === leg.strike &&
             x.expiry === leg.expiry && x.premium === leg.premium && x.lots === leg.lots && x.status === "STAGED")
          );
          if (idx >= 0) copy[idx] = { ...copy[idx], id: created.id };
          return copy;
        });
      }
    } catch (e) {
      console.warn("[stageLeg] createLeg failed; keeping local leg. Error:", e?.message || e);
    }
  };

  const updateStagedLots = async (idx, lots) => {
    const n = Math.max(1, Math.min(999, Number(lots) || 1));
    setStagedLegs((prev) => { const copy = [...prev]; if (copy[idx]) copy[idx] = { ...copy[idx], lots: n }; return copy; });
    const leg = stagedLegs[idx];
    if (leg?.id) await StrategyStore.updateLeg(leg.id, { lots: n });
  };

  const updateStagedOrderType = (idx, orderType) => {
    setStagedLegs((prev) => {
      const copy = [...prev];
      if (copy[idx]) copy[idx] = { ...copy[idx], order_type: String(orderType || "MARKET").toUpperCase() };
      return copy;
    });
  };

  const updateStagedLimitPrice = (idx, price) => {
    setStagedLegs((prev) => {
      const copy = [...prev];
      if (copy[idx]) copy[idx] = { ...copy[idx], limit_price: Number(price) };
      return copy;
    });
  };

  const placeStagedOne = async (idx) => {
    const leg = stagedLegs[idx];
    const entry = nowPrice(leg);
    setLiveLegs((l) => [...l, { ...leg, premium: entry }]);
    setStagedLegs((s) => s.filter((_, i) => i !== idx));
  try { if (strategyId) await placeOrdersForStrategy(strategyId, [mkOrderFromLeg(leg, "OPEN")]); } catch {}
    if (leg?.id) await StrategyStore.updateLeg(leg.id, { status: "OPEN", entryPrice: entry });
  };

  const placeStagedAll = async () => {
    if (!stagedLegs.length) return;
    const legs = [...stagedLegs];
    setLiveLegs((l) => [...l, ...legs.map((lg) => ({ ...lg, premium: nowPrice(lg) }))]);
    setStagedLegs([]);
  try { if (strategyId) await placeOrdersForStrategy(strategyId, legs.map((leg) => mkOrderFromLeg(leg, "OPEN"))); } catch {}
    for (const leg of legs) { if (leg?.id) await StrategyStore.updateLeg(leg.id, { status: "OPEN", entryPrice: nowPrice(leg) }); }
  };

  const removeStagedOne = async (idx) => {
    const leg = stagedLegs[idx];
    setStagedLegs((prev) => prev.filter((_, i) => i !== idx));
    if (leg?.id) await StrategyStore.deleteLeg(leg.id);
  };

  const clearStagedAll = async () => {
    const ids = stagedLegs.map((l) => l.id).filter(Boolean);
    setStagedLegs([]);
    for (const id of ids) await StrategyStore.deleteLeg(id);
  };

  const squareOffIndex = async (idx) => {
    const leg = liveLegs[idx];
    const exit = nowPrice(leg);
    setLiveLegs((prev) => prev.filter((_, i) => i !== idx));
    const sign = leg.side === "BUY" ? 1 : -1;
    const pnl = sign * (exit - (leg.premium || 0)) * (leg.lots || 1) * DEFAULT_LOT_SIZE;
    setRealized((r) => r + pnl);
    // Send closing order to brokers (reverse side)
    try {
      if (strategyId) {
        const closeOrder = mkOrderFromLeg({ ...leg, side: leg.side === "BUY" ? "SELL" : "BUY", order_type: "MARKET", limit_price: undefined }, "CLOSE");
        await placeOrdersForStrategy(strategyId, [closeOrder]);
      }
    } catch {}
    if (leg?.id) await StrategyStore.updateLeg(leg.id, { status: "CLOSED", exitPrice: exit });
  };

  const squareOffAll = async () => {
    if (!liveLegs.length) return;
    const legs = [...liveLegs]; // 🔧 fix typo (was livedLegs)
    setLiveLegs([]);
    let sum = 0;
    for (const leg of legs) {
      const exit = nowPrice(leg);
      const sign = leg.side === "BUY" ? 1 : -1;
      sum += sign * (exit - (leg.premium || 0)) * (leg.lots || 1) * DEFAULT_LOT_SIZE;
      // Fire close order per leg
      try {
        if (strategyId) {
          const closeOrder = mkOrderFromLeg({ ...leg, side: leg.side === "BUY" ? "SELL" : "BUY", order_type: "MARKET", limit_price: undefined }, "CLOSE");
          await placeOrdersForStrategy(strategyId, [closeOrder]);
        }
      } catch {}
      if (leg?.id) await StrategyStore.updateLeg(leg.id, { status: "CLOSED", exitPrice: exit });
    }
    setRealized((r) => r + sum);
  };

  const legsForPayoff = [...liveLegs, ...stagedLegs];

  // layout
  const gridStyle = isXL
    ? { display: "grid", gridTemplateColumns: `${ocCollapsed ? 0 : ocWidth}px ${HANDLE_PX}px 1fr`, gap: `${GAP_PX}px` }
    : undefined;

  const rightPaneClass = ocCollapsed
    ? "grid grid-cols-1 xl:grid-cols-2 gap-3 items-start"
    : "flex flex-col gap-3";

  const liveBadge =
    feedStatus === "connected" ? null :
    <div className="px-2 py-1 rounded bg-amber-50 text-amber-800 border border-amber-200 text-xs">
      Live feed: {feedStatus || "disconnected"}
    </div>;

  return (
    <div ref={containerRef} className="w-full" style={gridStyle}>
      {/* Option Chain */}
      <OptionChain
        spot={uiSpot}
        futPrice={uiFut}
        rows={mergedRows}
        expiries={expiries}
        selectedExpiry={selectedExpiry || undefined}
        onSelectExpiry={setSelectedExpiry}
        onAddLeg={stageLeg}
        onTableWidthChange={setTableWidth}
        atmBasis={atmBasis}
        onAtmBasisChange={setAtmBasis}
      />

      {isXL && (
        <div
          className="col-resizer"
          onMouseDown={startDrag}
          onDoubleClick={handleDoubleClick}
          title={ocCollapsed ? "Double-click: expand to FULL table • Drag to set width" : "Double-click: collapse • Drag to adjust"}
        />
      )}

      {/* Right pane */}
      <div className={rightPaneClass}>
        {/* Positions card */}
        <div className="card p-3">
          <div className="flex items-center justify-between">
            <div className="text-[15px] font-semibold">Positions</div>
            <div className="flex items-center gap-2">
              {liveBadge}
              <div className="text-sm px-2 py-1 rounded bg-blue-50 dark:bg-blue-gray-800">
                SPOT <span className="font-semibold">{Number(uiSpot ?? 0).toFixed(2)}</span>
                {' | '}
                FUT <span className="font-semibold">{Number(uiFut ?? 0).toFixed(2)}</span>
                {' | '}
                PCR <span className="font-semibold">{Number.isFinite(Number(pcr)) ? Number(pcr).toFixed(2) : '—'}</span>
              </div>
            </div>
          </div>
          <div className="mt-3">
            <PositionsList
              spot={uiFut ?? uiSpot}
              daysToExpiry={5}
              realized={realized}
              liveLegs={liveLegs}
              onSquareOff={squareOffIndex}
              onSquareOffAll={squareOffAll}
              stagedLegs={stagedLegs}
              onPlaceOne={placeStagedOne}
              onRemoveOne={removeStagedOne}
              onPlaceAll={placeStagedAll}
              onClearAll={clearStagedAll}
              defaultLots={defaultLots}
              onChangeDefaultLots={setDefaultLots}
              onUpdateStagedLots={updateStagedLots}
              onUpdateStagedOrderType={updateStagedOrderType}
              onUpdateStagedLimitPrice={updateStagedLimitPrice}
              defaultExpiry={selectedExpiry || undefined}
              strategyId={strategyId}
            />
          </div>
        </div>

        {/* Payoff card */}
        <PayoffPanel legs={legsForPayoff} spot={uiSpot} daysToExpiry={5} realized={realized} />
      </div>
    </div>
  );
}
