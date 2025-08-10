import React, { useEffect, useMemo, useRef, useState } from "react";
import PayoffPanel from "../components/PayoffPanel.jsx";
import PositionsList from "../components/PositionsList.jsx";
import OptionChain from "../components/OptionChain.jsx";
import useSocket from "../hooks/useSocket.js";
import { bsPrice } from "../utils/bs.js";
import { DEFAULT_LOT_SIZE, DEFAULT_RF_RATE, DEFAULT_IV } from "../config.js";
import { placeOrders } from "../utils/api.js";
import * as StrategyStore from "../utils/strategyStore.js";

console.log("%cDashboard v7 (DB strategies + legs; clean load/switch)", "color:#0ea5e9");

export default function Dashboard() {
  const { spot } = useSocket();

  const [prevCloseNifty] = useState(24450);
  const [vix] = useState(12.8);
  const [prevCloseVix] = useState(12.5);

  // Broadcast market summary (incl PCR from below)
  useEffect(() => {
    window.dispatchEvent(
      new CustomEvent("market:update", {
        detail: { spot, prevCloseNifty, vix, prevCloseVix },
      })
    );
  }, [spot, prevCloseNifty, vix, prevCloseVix]);

  // ----- resizable OC pane -----
  const containerRef = useRef(null);
  const GAP_PX = 12, HANDLE_PX = 6, minW = 360;
  const [ocWidth, setOcWidth] = useState(() => Number(localStorage.getItem("oc.width.px")) || 420);
  const [ocCollapsed, setOcCollapsed] = useState(() => localStorage.getItem("oc.collapsed") === "1");
  const [tableWidth, setTableWidth] = useState(700);

  const [isXL, setIsXL] = useState(() =>
    typeof window !== "undefined" ? window.innerWidth >= 1280 : true
  );
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

  // ===== Option Chain model (incl PCR broadcast) =====
  const [atmBasis, setAtmBasis] = useState(() => localStorage.getItem("atm.basis") || "spot");
  useEffect(() => { localStorage.setItem("atm.basis", atmBasis); }, [atmBasis]);

  const futPrice = useMemo(() => (Number.isFinite(spot) ? spot + 79 : 24429), [spot]);
  const refPrice = useMemo(() => {
    const src = atmBasis === "futures" ? futPrice : spot;
    const n = Number(src);
    return Number.isFinite(n) ? n : 24400;
  }, [atmBasis, futPrice, spot]);

  const expiries = useMemo(
    () => [
      { code: "2024-08-14", label: "14 AUG (5d)", days: 5 },
      { code: "2024-08-21", label: "21 AUG (12d)", days: 12 },
      { code: "2024-08-28", label: "28 AUG (19d)", days: 19 },
      { code: "2024-09-02", label: "02 SEP (24d)", days: 24 },
      { code: "2024-09-11", label: "11 SEP (33d)", days: 33 },
      { code: "2024-09-25", label: "25 SEP (47d)", days: 47 },
    ],
    []
  );
  const [selectedExpiry, setSelectedExpiry] = useState(expiries[0].code);

  const STEP = 50, HALF = 20;
  const gauss = (x, mu, sigma) => Math.exp(-((x - mu) ** 2) / (2 * sigma * sigma));
  const buildChain = (ref, days) => {
    const t = Math.max(1 / 365, days / 365);
    const center = Math.round(ref / STEP) * STEP;
    const start = center - HALF * STEP;
    const peakCall = center + 200, peakPut = center - 200, sigma = 320;
    const underlying = Number.isFinite(spot) ? spot : ref;
    const rows = [];
    for (let i = 0; i <= 2 * HALF; i++) {
      const strike = start + i * STEP;
      const callLtp = +bsPrice(underlying, strike, DEFAULT_RF_RATE, DEFAULT_IV, t, "C").toFixed(2);
      const putLtp = +bsPrice(underlying, strike, DEFAULT_RF_RATE, DEFAULT_IV, t, "P").toFixed(2);
      const dist = (strike - ref) / STEP;
      const deltaC = +Math.max(-1, Math.min(1, 0.5 - 0.025 * dist)).toFixed(2);
      const deltaP = +(-1 * (1 + deltaC)).toFixed(2);
      const callOi = Math.round(18000 * gauss(strike, peakCall, sigma) + 6000);
      const putOi = Math.round(16000 * gauss(strike, peakPut, sigma) + 5000);
      const iv = +(12 + Math.min(3, Math.abs(dist) * 0.12)).toFixed(1);
      rows.push({ strike, deltaC, deltaP, callLtp, putLtp, callOi, putOi, iv });
    }
    return rows;
  };

  const [chainRows, setChainRows] = useState(() => buildChain(refPrice, expiries[0].days));
  useEffect(() => {
    const exp = expiries.find((e) => e.code === selectedExpiry) || expiries[0];
    setChainRows(buildChain(refPrice, exp.days));
  }, [refPrice, selectedExpiry, spot]); // eslint-disable-line

  // PCR compute + baseline + broadcast
  const pcr = useMemo(() => {
    if (!chainRows.length) return undefined;
    let sumPut = 0, sumCall = 0;
    for (const r of chainRows) {
      sumPut += Number(r.putOi) || 0;
      sumCall += Number(r.callOi) || 0;
    }
    if (sumCall <= 0) return undefined;
    return sumPut / sumCall;
  }, [chainRows]);

  const dayKey = (() => {
    const dt = new Date();
    const y = dt.getFullYear(), m = String(dt.getMonth() + 1).padStart(2, "0"), d = String(dt.getDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
  })();
  const [pcrOpen, setPcrOpen] = useState(() => {
    try { const raw = localStorage.getItem(`pcr.open.${dayKey}`); return raw ? Number(raw) : undefined; }
    catch { return undefined; }
  });
  useEffect(() => {
    if (!Number.isFinite(pcr) || Number.isFinite(pcrOpen)) return;
    try { localStorage.setItem(`pcr.open.${dayKey}`, String(pcr)); } catch {}
    setPcrOpen(pcr);
  }, [pcr, pcrOpen, dayKey]);
  useEffect(() => {
    window.dispatchEvent(
      new CustomEvent("market:update", {
        detail: { spot, prevCloseNifty, vix, prevCloseVix, pcr, pcrOpen },
      })
    );
  }, [spot, prevCloseNifty, vix, prevCloseVix, pcr, pcrOpen]);

  // ---------------- Strategy state & persistence ----------------
  const [strategyId, setStrategyId] = useState(null);
  const [defaultLots, setDefaultLots] = useState(1);
  const [liveLegs, setLiveLegs] = useState([]);
  const [stagedLegs, setStagedLegs] = useState([]);
  const [realized, setRealized] = useState(0);

  // --------- Load helper (single source of truth) ----------
  const loadStrategyState = async (id) => {
    const sid = id || StrategyStore.getCurrentId();
    if (!sid) return;

    // StrategyStore.loadStateAsync returns normalized { liveLegs, stagedLegs, realized, defaultLots, atmBasis, underlying, selectedExpiry }
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

  // Initial load: pick a strategy, then load legs + prefs from DB
  useEffect(() => {
    (async () => {
      let id = StrategyStore.getCurrentId();

      if (!id) {
        const list = await StrategyStore.listAsync(true);
        id = list?.[0]?.id;
      }
      if (!id) {
        id = await StrategyStore.createAsync("My First Strategy");
      }
      StrategyStore.setCurrentId(id);
      await loadStrategyState(id);
    })();
  }, []);

  // Persist prefs (NOT legs; legs are persisted per action)
  useEffect(() => {
    if (!strategyId) return;
    StrategyStore.saveState(strategyId, {
      defaultLots,
      atmBasis,
      selectedExpiry,
      underlying: localStorage.getItem("ui.underlying") || "NIFTY",
    });
  }, [strategyId, defaultLots, atmBasis, selectedExpiry]);

  // On strategy switch (Topbar fires either of these events)
  useEffect(() => {
    const onSelected = async (e) => { await loadStrategyState(String(e.detail)); };
    const onSwitch   = async (e) => { await loadStrategyState(String(e.detail?.id)); };
    window.addEventListener("strategy:selected", onSelected);
    window.addEventListener("strategy:switch", onSwitch);
    return () => {
      window.removeEventListener("strategy:selected", onSelected);
      window.removeEventListener("strategy:switch", onSwitch);
    };
  }, []); // loadStrategyState defined above

  // -------- staging & positions (DB-backed) --------
  const [daysToExpiry] = useState(5);
  const t = Math.max(1 / 365, daysToExpiry / 365);

  // Stage a leg (persist STAGED)
  const stageLeg = async (side, type, strike, premium, expiry) => {
    const leg = { side, type, strike, premium, lots: defaultLots, expiry, status: "STAGED" };
    setStagedLegs((s) => [...s, leg]); // optimistic
    try {
      const created = await StrategyStore.createLeg(strategyId, leg);
      setStagedLegs((prev) => {
        const copy = [...prev];
        const idx = copy.findIndex((x) => x === leg);
        if (idx >= 0) copy[idx] = { ...leg, id: created?.id };
        return copy;
      });
    } catch {
      setStagedLegs((prev) => prev.filter((x) => x !== leg)); // revert on fail
    }
  };

  const updateStagedLots = async (idx, lots) => {
    const n = Math.max(1, Math.min(999, Number(lots) || 1));
    setStagedLegs((prev) => {
      const copy = [...prev];
      if (copy[idx]) copy[idx] = { ...copy[idx], lots: n };
      return copy;
    });
    const leg = stagedLegs[idx];
    if (leg?.id) await StrategyStore.updateLeg(leg.id, { lots: n });
  };

  const nowPrice = (leg) => {
    const type = leg.type === "CE" ? "C" : "P";
    return bsPrice(spot, leg.strike, DEFAULT_RF_RATE, DEFAULT_IV, t, type);
  };

  const mkOrderFromLeg = (leg, action = "OPEN") => ({
    symbol: "NIFTY",
    exchange: "NFO",
    product: "NRML",
    order_type: "MARKET",
    side: leg.side,
    option_type: leg.type,
    strike: leg.strike,
    price: nowPrice(leg),
    lots: leg.lots || 1,
    lot_size: DEFAULT_LOT_SIZE,
    expiry: leg.expiry,
    expiryDate: leg.expiry,
    action,
  });

  const placeStagedOne = async (idx) => {
    const leg = stagedLegs[idx];
    const entry = nowPrice(leg);
    // optimistic UI
    setLiveLegs((l) => [...l, { ...leg, premium: entry }]);
    setStagedLegs((s) => s.filter((_, i) => i !== idx));
    try { await placeOrders([mkOrderFromLeg(leg, "OPEN")]); } catch {}
    // persist to DB
    if (leg?.id) await StrategyStore.updateLeg(leg.id, { status: "OPEN", entryPrice: entry });
  };

  const placeStagedAll = async () => {
    if (!stagedLegs.length) return;
    const legs = [...stagedLegs];
    // optimistic
    setLiveLegs((l) => [...l, ...legs.map((lg) => ({ ...lg, premium: nowPrice(lg) }))]);
    setStagedLegs([]);
    try { await placeOrders(legs.map((leg) => mkOrderFromLeg(leg, "OPEN"))); } catch {}
    // persist all
    for (const leg of legs) {
      if (leg?.id) await StrategyStore.updateLeg(leg.id, { status: "OPEN", entryPrice: nowPrice(leg) });
    }
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
    // optimistic local
    setLiveLegs((prev) => prev.filter((_, i) => i !== idx));
    const sign = leg.side === "BUY" ? 1 : -1;
    const pnl = sign * (exit - (leg.premium || 0)) * (leg.lots || 1) * DEFAULT_LOT_SIZE;
    setRealized((r) => r + pnl);
    // persist close
    if (leg?.id) await StrategyStore.updateLeg(leg.id, { status: "CLOSED", exitPrice: exit });
  };

  const squareOffAll = async () => {
    if (!liveLegs.length) return;
    const legs = [...liveLegs];
    setLiveLegs([]);
    let sum = 0;
    for (const leg of legs) {
      const exit = nowPrice(leg);
      const sign = leg.side === "BUY" ? 1 : -1;
      sum += sign * (exit - (leg.premium || 0)) * (leg.lots || 1) * DEFAULT_LOT_SIZE;
      if (leg?.id) await StrategyStore.updateLeg(leg.id, { status: "CLOSED", exitPrice: exit });
    }
    setRealized((r) => r + sum);
  };

  const legsForPayoff = useMemo(() => [...liveLegs, ...stagedLegs], [liveLegs, stagedLegs]);

  // Container grid for OC + handle + right pane (only on XL to keep UX sane)
  const gridStyle = isXL
    ? { display: "grid", gridTemplateColumns: `${ocCollapsed ? 0 : ocWidth}px ${HANDLE_PX}px 1fr`, gap: `${GAP_PX}px` }
    : undefined;

  const rightPaneClass = ocCollapsed
    ? "grid grid-cols-1 xl:grid-cols-2 gap-3 items-start"
    : "flex flex-col gap-3";

  return (
    <div ref={containerRef} className="w-full" style={gridStyle}>
      {/* Option Chain */}
      <OptionChain
        spot={spot}
        futPrice={Number.isFinite(spot) ? spot + 79 : 24429}
        rows={chainRows}
        expiries={expiries}
        selectedExpiry={selectedExpiry}
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
          title={
            ocCollapsed
              ? "Double-click: expand to FULL table • Drag to set width"
              : "Double-click: collapse • Drag to adjust"
          }
        />
      )}

      {/* Right pane */}
      <div className={rightPaneClass}>
        {/* Positions card */}
        <div className="card p-3">
          <div className="flex items-center justify-between">
            <div className="text-[15px] font-semibold">Positions</div>
            <div className="text-sm px-2 py-1 rounded bg-blue-50 dark:bg-blue-gray-800">
              FUT (28 Aug){" "}
              <span className="font-semibold">{Number((spot ?? 24429) + 79).toFixed(2)}</span>
            </div>
          </div>
          <div className="mt-3">
            <PositionsList
              spot={spot}
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
              defaultExpiry={selectedExpiry}
            />
          </div>
        </div>

        {/* Payoff card */}
        <PayoffPanel legs={legsForPayoff} spot={spot} daysToExpiry={5} realized={realized} />
      </div>
    </div>
  );
}
