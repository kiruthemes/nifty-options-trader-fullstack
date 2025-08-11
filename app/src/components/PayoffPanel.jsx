// app/src/components/PayoffPanel.jsx
import React, { useEffect, useMemo, useRef, useState } from "react";
import Chart from "react-apexcharts";
import { inr } from "../utils/format.js";
import { DEFAULT_LOT_SIZE, DEFAULT_RF_RATE, DEFAULT_IV } from "../config.js";
import { bsPrice, greeks } from "../utils/bs.js";

export default function PayoffPanel({ legs = [], spot = NaN, daysToExpiry = 5, realized = 0 }) {
  const t = Math.max(1 / 365, daysToExpiry / 365);
  const lot = DEFAULT_LOT_SIZE;
  const r = DEFAULT_RF_RATE;

  // ---- Y-axis layout constants ----
  const Y_TICK_STEP_BASE = 10000; // desired per-tick gap
  const Y_TICK_COUNT     = 4;     // total ticks including min & max
  const TOP_FRACTION     = 0.30;  // keep 0 near the top

  // --- sample spot every 20s (no real-time thrash) ---
  const latestSpotRef = useRef(spot);
  const [sampledSpot, setSampledSpot] = useState(spot);
  useEffect(() => { latestSpotRef.current = spot; }, [spot]);
  useEffect(() => {
    setSampledSpot(latestSpotRef.current);
    const id = setInterval(() => setSampledSpot(latestSpotRef.current), 20000);
    return () => clearInterval(id);
  }, []);

  const calc = useMemo(() => {
    if (!legs.length) {
      const safeSpot = Number.isFinite(sampledSpot) ? sampledSpot : 24350;
      const x0 = Math.max(1, Math.round(safeSpot - 500));
      const x1 = Math.round(safeSpot + 500);
      return {
        expiryPts: [{ x: x0, y: 0 }, { x: x1, y: 0 }],
        todayPts:  [{ x: x0, y: 0 }, { x: x1, y: 0 }],
        metrics: baseMetrics(realized),
        greeksAgg: zeroGreeks(),
        range: { xMin: x0, xMax: x1, be1: null, be2: null },
        sampledSpot: safeSpot,
      };
    }

    const safeSpot = Number.isFinite(sampledSpot) ? sampledSpot : 24350;
    const strikes = legs.map((l) => l.strike);
    const xMin = Math.max(1, Math.min(...strikes, safeSpot) - 800);
    const xMax = Math.max(...strikes, safeSpot) + 800;
    const step = Math.max(10, Math.round((xMax - xMin) / 160));

    const legsWithIv = legs.map((l) => ({ ...l, iv: Number(l.iv) || DEFAULT_IV }));

    const expiryAt = (p) => {
      let s = 0;
      for (const l of legs) {
        const lots = (l.lots || 1) * lot;
        const intrinsic = l.type === "CE" ? Math.max(0, p - l.strike) : Math.max(0, l.strike - p);
        const raw = intrinsic - (l.premium || 0);
        s += (l.side === "BUY" ? 1 : -1) * raw * lots;
      }
      return s;
    };
    const todayAt = (p) => {
      let s = 0;
      for (const l of legsWithIv) {
        const type = l.type === "CE" ? "C" : "P";
        const lots = (l.lots || 1) * lot;
        const val = bsPrice(p, l.strike, r, l.iv, t, type);
        s += (l.side === "BUY" ? 1 : -1) * (val - (l.premium || 0)) * lots;
      }
      return s;
    };

    const expiryPts = [];
    const todayPts  = [];
    let maxProfit = -Infinity, maxLoss = Infinity;

    for (let p = xMin; p <= xMax; p += step) {
      const e = expiryAt(p);
      const d = todayAt(p);
      expiryPts.push({ x: Math.round(p), y: e });
      todayPts.push({ x: Math.round(p), y: d });
      if (e > maxProfit) maxProfit = e;
      if (e < maxLoss)  maxLoss  = e;
    }

    // MTM & Greeks at sampled spot
    let mtm = 0, gDelta = 0, gGamma = 0, gTheta = 0, gVega = 0;
    for (const l of legsWithIv) {
      const type = l.type === "CE" ? "C" : "P";
      const lotsSigned = (l.lots || 1) * lot * (l.side === "BUY" ? 1 : -1);
      const now = bsPrice(safeSpot, l.strike, r, l.iv, t, type);
      mtm += (now - (l.premium || 0)) * lotsSigned;
      const G = greeks(safeSpot, l.strike, r, l.iv, t, type);
      gDelta += G.delta * lotsSigned;
      gGamma += G.gamma * lotsSigned;
      gTheta += G.theta * lotsSigned;
      gVega  += G.vega  * lotsSigned;
    }
    const mtmTotal = Math.abs(mtm + (realized || 0)) < 0.5 ? 0 : mtm + (realized || 0);

    // breakevens from expiry
    const breaks = [];
    for (let i = 1; i < expiryPts.length; i++) {
      const a = expiryPts[i - 1], b = expiryPts[i];
      if ((a.y <= 0 && b.y >= 0) || (a.y >= 0 && b.y <= 0)) {
        const m = (b.y - a.y) / (b.x - a.x);
        const c = a.y - m * a.x;
        breaks.push(Math.round(-c / m));
      }
    }
    let be1 = null, be2 = null;
    if (breaks.length >= 2) { be1 = Math.min(...breaks); be2 = Math.max(...breaks); }
    else if (breaks.length === 1) { be1 = breaks[0]; }

    const risk = Math.abs(Math.min(0, maxLoss));
    const reward = Math.max(0, maxProfit);
    const rr = risk > 0 ? (reward / risk).toFixed(2) : "NA";

    const beText = breaks.length
      ? breaks
          .sort((a, b) => a - b)
          .map((x) => `${x} (${(((x - safeSpot) / safeSpot) * 100).toFixed(2)}%)`)
          .join(" / ")
      : "—";

    return {
      expiryPts, todayPts,
      metrics: {
        mtm: mtmTotal, maxProfit: reward, maxLoss: -risk,
        riskReward: rr, margin: approxMarginConstant(legs),
        breakevenText: beText, _profitAbs: reward, _lossAbs: risk,
      },
      greeksAgg: { delta: gDelta, gamma: gGamma, theta: gTheta, vega: gVega },
      range: { xMin, xMax, be1, be2 },
      sampledSpot: safeSpot,
    };
  }, [JSON.stringify(legs), sampledSpot, daysToExpiry, realized]);

  const themeKey = document.documentElement.classList.contains("dark") ? "dark" : "light";

  // --- memoize piecewise mapper & mapped data ---
  const map = useMemo(() => buildPiecewiseMap(calc.range), [calc]);
  const mapped = useMemo(() => {
    const mapSeries = (arr) => arr.map((p) => [map.toU(p.x), p.y]);
    return {
      expiryLine: mapSeries(calc.expiryPts),
      todayLine:  mapSeries(calc.todayPts),
      profitArea: mapSeries(calc.expiryPts.map((p) => ({ x: p.x, y: p.y > 0 ? p.y : null }))),
      lossArea:   mapSeries(calc.expiryPts.map((p) => ({ x: p.x, y: p.y < 0 ? p.y : null }))),
    };
  }, [calc, map]);

  // ---- Y axis
  const { yMin, yMax, tickAmount: yTickAmount } = useMemo(
    () => computeYAxisLayout(
      calc.metrics._profitAbs,
      calc.metrics._lossAbs,
      {
        baseStep: Y_TICK_STEP_BASE,
        tickCount: Y_TICK_COUNT,
        topFrac: TOP_FRACTION,
        minFracForMinY: 0.90,
        pad: 1.10,
      }
    ),
    [calc.metrics._profitAbs, calc.metrics._lossAbs]
  );

  // X ticks ~300–400 apart
  const tickAmount = useMemo(() => {
    const xRange = calc.range.xMax - calc.range.xMin || 1;
    return clamp(Math.round(xRange / 350), 5, 14);
  }, [calc.range.xMax, calc.range.xMin]);

  const showAnno = Number.isFinite(calc.sampledSpot);

  const series = useMemo(
    () => [
      { name: "Profit zone", type: "area", data: mapped.profitArea },
      { name: "Loss zone",   type: "area", data: mapped.lossArea },
      { name: "Expiry",      type: "line", data: mapped.expiryLine },
      { name: "Today (BS)",  type: "line", data: mapped.todayLine },
    ],
    [mapped, themeKey]
  );

  const options = useMemo(() => ({
    chart: {
      type: "line",
      height: 360,
      toolbar: { show: false },
      animations: { enabled: false },
      redrawOnWindowResize: false,
      redrawOnParentResize: false,
      foreColor: themeKey === "dark" ? "#cbd5e1" : "#475569",
      stacked: false,
      id: "payoff-chart",
    },
    stroke: { curve: "straight", width: [0, 0, 2, 2] },
    fill:   { opacity: [0.18, 0.12, 1, 1] },
    colors: ["#10b981", "#ef4444", "#ef4444", "#2563eb"],
    markers: { size: 0 },
    grid: { borderColor: "rgba(148,163,184,.25)" },
    dataLabels: { enabled: false },
    legend: { show: false },

    xaxis: {
      type: "numeric",
      min: 0, max: 100,
      tickAmount,
      decimalsInFloat: 0,
      labels: {
        rotate: -55, rotateAlways: true, hideOverlappingLabels: true, minHeight: 56,
        formatter: (u) => map.toX(u).toLocaleString("en-IN"),
      },
      title: { text: "Underlying Price" },
    },

    yaxis: {
      min: yMin,
      max: yMax,
      tickAmount: yTickAmount,
      labels: {
        hideOverlappingLabels: true,
        formatter: (v) => "₹ " + Math.round(v).toLocaleString("en-IN"),
      },
      title: { text: "P&L (₹)" },
    },

    annotations: {
      xaxis: showAnno ? [{
        x: map.toU(calc.sampledSpot),
        strokeDashArray: 4,
        borderColor: "#f59e0b",
        label: {
          text: `Spot: ₹ ${calc.sampledSpot.toLocaleString("en-IN")}`,
          style: { background: "#f59e0b", color: "#111827" },
        },
      }] : [],
    },

    tooltip: {
      shared: true,
      fixed: { enabled: false },
      custom: ({ dataPointIndex, w }) => {
        const u = w.globals.seriesX[0]?.[dataPointIndex] ?? w.globals.seriesX[1]?.[dataPointIndex] ?? 0;
        const px = map.toX(u);
        const baseSpot = calc.sampledSpot || px;
        const awayPct = ((px - baseSpot) / baseSpot) * 100;
        return `
          <div style="padding:8px 10px;font-size:12px">
            <div><b>Underlying:</b> ₹ ${px.toLocaleString("en-IN")}
              <span style="opacity:.8"> (${awayPct >= 0 ? "+" : ""}${isFinite(awayPct) ? awayPct.toFixed(2) : "0.00"}%)</span>
            </div>
            <div style="margin-top:4px;opacity:.85">P&L (Expiry): ${inr(w.globals.series[2][dataPointIndex])}</div>
            <div style="opacity:.85">P&L (Today): ${inr(w.globals.series[3][dataPointIndex])}</div>
          </div>`;
      },
    },
  }), [themeKey, tickAmount, yMin, yMax, map, showAnno, calc.sampledSpot]);

  const safeSpotText = Number.isFinite(spot) ? Number(spot).toLocaleString("en-IN") : "—";

  return (
    <div className="card p-4">
      <div className="flex items-center justify-between">
        <div className="text-[15px] font-semibold">Analysis</div>
        <div className="muted text-sm">
          MTM:{" "}
          <span className={calc.metrics.mtm >= 0 ? "text-emerald-600" : "text-red-600"}>
            {inr(calc.metrics.mtm)}
          </span>{" "}
          | Spot: ₹ {safeSpotText}
        </div>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-5 gap-3 my-4">
        <K label="Total MTM" v={inr(calc.metrics.mtm)} />
        <K label="Maximum Profit" v={inr(calc.metrics.maxProfit)} />
        <K label="Risk/Reward" v={calc.metrics.riskReward} />
        <K label="Maximum Loss" v={inr(calc.metrics.maxLoss)} />
        <K label="Margin Approx" v={inr(calc.metrics.margin)} />
        {/* Breakeven tile removed */}
        <K label="Delta" v={fmtNum(calc.greeksAgg.delta, 3)} />
        <K label="Gamma" v={Number(calc.greeksAgg.gamma).toExponential(3)} />
        <K label="Theta" v={fmtNum(calc.greeksAgg.theta, 0)} />
        <K label="Vega" v={fmtNum(calc.greeksAgg.vega, 0)} />
      </div>

      {/* Legend + Breakevens inline */}
      <div className="flex flex-wrap items-center gap-4 text-sm mb-2">
        <span className="inline-flex items-center gap-2"><Dot color="#ef4444" /> Expiry</span>
        <span className="inline-flex items-center gap-2"><Dot color="#2563eb" /> Today (BS)</span>
        <span className="muted">•</span>
        <span className="text-xs sm:text-sm">
          <span className="muted">Breakeven(s): </span>
          <b>{calc.metrics.breakevenText}</b>
        </span>
      </div>

      <div className="w-full">
        <Chart options={options} series={series} type="line" height={360} />
      </div>
    </div>
  );
}

/* ---------- helpers ---------- */
function K({ label, v }) {
  return (
    <div className="p-3 rounded-lg bg-gray-50 dark:bg-blue-gray-800 border border-blue-gray-50/50 dark:border-blue-gray-700">
      <div className="muted text-[11px]">{label}</div>
      <div className="text-sm font-semibold">{v}</div>
    </div>
  );
}
const Dot = ({ color }) => <span aria-hidden className="inline-block w-3 h-3 rounded-full" style={{ background: color }} />;

function baseMetrics(realized = 0) {
  return { mtm: realized, maxProfit: 0, maxLoss: 0, riskReward: "NA", margin: 0, breakevenText: "—", _profitAbs: 0, _lossAbs: 0 };
}
function zeroGreeks() { return { delta: 0, gamma: 0, theta: 0, vega: 0 }; }

function clamp(x, lo, hi) { return Math.max(lo, Math.min(hi, x)); }

// piecewise map: profit band in middle ~30%
function buildPiecewiseMap({ xMin, xMax, be1, be2 }) {
  const leftPad = 5, leftEnd = 35, midEnd = 65, rightEnd = 95;
  const hasTwoBE = Number.isFinite(be1) && Number.isFinite(be2) && be2 > be1;
  const span = xMax - xMin || 1;
  const toU = (x) => {
    if (!hasTwoBE) return clamp(leftPad + ((x - xMin) / span) * (rightEnd - leftPad), 0, 100);
    if (x <= be1) return leftPad + ((x - xMin) / (be1 - xMin)) * (leftEnd - leftPad);
    if (x >= be2) return midEnd + ((x - be2) / (xMax - be2)) * (rightEnd - midEnd);
    return leftEnd + ((x - be1) / (be2 - be1)) * (midEnd - leftEnd);
  };
  const toX = (u) => {
    const U = clamp(u, 0, 100);
    if (!hasTwoBE) return Math.round(xMin + ((U - leftPad) / (rightEnd - leftPad)) * span);
    if (U <= leftEnd) return Math.round(xMin + ((U - leftPad) / (leftEnd - leftPad)) * (be1 - xMin));
    if (U >= midEnd)  return Math.round(be2 + ((U - midEnd) / (rightEnd - midEnd)) * (xMax - be2));
    return Math.round(be1 + ((U - leftEnd) / (midEnd - leftEnd)) * (be2 - be1));
  };
  return { toU, toX };
}

/**
 * Y-axis layout helper (keeps exact tick count & gap multiples).
 */
function computeYAxisLayout(
  profitAbs,
  lossAbs,
  { baseStep = 20000, tickCount = 10, topFrac = 0.10, minFracForMinY = 0.90, pad = 1.10 } = {}
) {
  const intervals = tickCount - 1;
  const K = (1 - topFrac) / topFrac;

  const needProfit = (profitAbs || 0) * pad;
  const needLoss   = (lossAbs   || 0) * pad;

  const stepMin = Math.ceil(needProfit / (topFrac * intervals * baseStep)) * baseStep;
  const C = minFracForMinY * (1 + K) - 1;
  const stepMax = C > 0
    ? Math.floor(needLoss / (C * topFrac * intervals * baseStep)) * baseStep
    : Infinity;

  let step = Math.max(baseStep, stepMin);
  if (stepMax >= step) step = Math.min(step, stepMax);

  const totalRange = intervals * step;
  const yMax = topFrac * totalRange;
  const yMin = yMax - totalRange;

  return { yMin, yMax, tickAmount: tickCount };
}

function approxMarginConstant(legs) {
  let shortRisk = 0, longOffset = 0;
  for (const l of legs) {
    const lots = (l.lots || 1) * DEFAULT_LOT_SIZE;
    const base = l.strike * lots; // strike-based approximation
    if (l.side === "SELL") shortRisk += base * 0.15;
    else longOffset += Math.min(base * 0.08, shortRisk * 0.5);
  }
  return Math.max(0, shortRisk - longOffset);
}
function fmtNum(n, dps = 2) { return Number.isFinite(n) ? Number(n).toFixed(dps) : "—"; }
