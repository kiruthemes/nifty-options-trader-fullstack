import React, { useMemo } from "react";
import Chart from "react-apexcharts";
import { inr } from "../utils/format.js";
import { DEFAULT_LOT_SIZE, DEFAULT_RF_RATE, DEFAULT_IV } from "../config.js";
import { bsPrice, greeks, impliedVol } from "../utils/bs.js";

/**
 * legs: [{ side:'BUY'|'SELL', type:'CE'|'PE', strike:number, premium:number, lots:number }]
 * spot: number (live price)
 * daysToExpiry: number
 * realized: number (realized P&L from squared-off legs)
 */
export default function PayoffPanel({
  legs = [],
  spot = 24350,
  daysToExpiry = 5,
  realized = 0,
}) {
  const t = Math.max(1 / 365, daysToExpiry / 365);
  const lot = DEFAULT_LOT_SIZE;
  const r = DEFAULT_RF_RATE;

  const calc = useMemo(() => {
    if (!legs.length) {
      // empty state: flat line around spot
      const base = [
        { x: Math.max(1, Math.round(spot - 500)), y: 0 },
        { x: Math.round(spot + 500), y: 0 },
      ];
      return {
        points: base,
        metrics: baseMetrics(realized),
        greeksAgg: zeroGreeks(),
      };
    }

    const strikes = legs.map((l) => l.strike);
    const minP = Math.max(1, Math.min(...strikes, spot) - 800);
    const maxP = Math.max(...strikes, spot) + 800;
    const step = Math.max(10, Math.round((maxP - minP) / 160));
    const grid = [];

    let maxProfit = -Infinity;
    let maxLoss = Infinity;

    // Estimate IV (if premium provided) so MTM/curve reacts to spot + time
    const legsWithIv = legs.map((l) => {
      const type = l.type === "CE" ? "C" : "P";
      const tgt = Math.max(0.0001, Number(l.premium || 0));
      const iv =
        tgt > 0
          ? impliedVol(tgt, spot, l.strike, r, t, type, DEFAULT_IV)
          : DEFAULT_IV;
      return { ...l, iv };
    });

    for (let p = minP; p <= maxP; p += step) {
      let payoff = 0;
      for (const l of legsWithIv) {
        const type = l.type === "CE" ? "C" : "P";
        const optVal = bsPrice(p, l.strike, r, l.iv, t, type);
        const signed = (l.side === "BUY" ? 1 : -1) * (optVal - l.premium);
        payoff += signed * (l.lots || 1) * lot;
      }
      grid.push({ x: Math.round(p), y: payoff });
      if (payoff > maxProfit) maxProfit = payoff;
      if (payoff < maxLoss) maxLoss = payoff;
    }

    // Live MTM & Greeks at current spot
    let mtm = 0,
      gDelta = 0,
      gGamma = 0,
      gTheta = 0,
      gVega = 0;

    for (const l of legsWithIv) {
      const type = l.type === "CE" ? "C" : "P";
      const priceNow = bsPrice(spot, l.strike, r, l.iv, t, type);
      const signed = (l.side === "BUY" ? 1 : -1) * (priceNow - l.premium);
      mtm += signed * (l.lots || 1) * lot;

      const G = greeks(spot, l.strike, r, l.iv, t, type);
      const sgn = (l.side === "BUY" ? 1 : -1) * (l.lots || 1) * lot;
      gDelta += G.delta * sgn;
      gGamma += G.gamma * sgn;
      gTheta += G.theta * sgn;
      gVega += G.vega * sgn;
    }

    // Breakevens (zero crossings)
    const bps = [];
    for (let i = 1; i < grid.length; i++) {
      const a = grid[i - 1],
        b = grid[i];
      if ((a.y <= 0 && b.y >= 0) || (a.y >= 0 && b.y <= 0)) {
        const m = (b.y - a.y) / (b.x - a.x);
        const c = a.y - m * a.x;
        const x = -c / m;
        bps.push(Math.round(x));
      }
    }
    const breakevenValue = bps.length ? bps.join(" / ") : "—";
    const breakevenPercent = bps.length
      ? (((bps[0] - spot) / spot) * 100).toFixed(2)
      : "—";

    const risk = Math.abs(Math.min(0, maxLoss));
    const reward = Math.max(0, maxProfit);
    const rr = risk > 0 ? (reward / risk).toFixed(2) : "NA";

    return {
      points: grid,
      metrics: {
        mtm: mtm + (realized || 0), // include realized P&L
        maxProfit: reward,
        maxLoss: -risk,
        riskReward: rr,
        margin: approxMargin(legsWithIv, spot, lot),
        breakevenValue,
        breakevenPercent,
      },
      greeksAgg: { delta: gDelta, gamma: gGamma, theta: gTheta, vega: gVega },
    };
  }, [JSON.stringify(legs), spot, daysToExpiry, realized]);

  const themeKey = document.documentElement.classList.contains("dark")
    ? "dark"
    : "light";

  const series = [
    { name: "Payoff", data: calc.points.map((p) => [p.x, p.y]) },
  ];

  const options = {
    chart: {
      type: "line",
      height: 360,
      toolbar: { show: false },
      animations: { enabled: true, easing: "easeinout", speed: 250 },
      foreColor: themeKey === "dark" ? "#cbd5e1" : "#475569",
    },
    stroke: { width: 2, curve: "smooth" },
    xaxis: { title: { text: "Underlying Price" } },
    yaxis: {
      title: { text: "P&L (₹)" },
      labels: {
        formatter: (v) => "₹ " + Math.round(v).toLocaleString("en-IN"),
      },
    },
    grid: { borderColor: "rgba(148,163,184,.25)" },
    theme: { mode: themeKey },
    // Green area above 0, red below 0; spot marker
    annotations: {
      yaxis: [
        {
          y: 0,
          y2: 1e9,
          borderColor: "transparent",
          fillColor: "rgba(16,185,129,.10)",
        },
        {
          y: -1e9,
          y2: 0,
          borderColor: "transparent",
          fillColor: "rgba(239,68,68,.10)",
        },
      ],
      xaxis: [
        {
          x: spot,
          borderColor: "#f59e0b",
          label: {
            text: `Spot: ₹ ${spot.toLocaleString("en-IN")}`,
            style: { background: "#f59e0b", color: "#111827" },
          },
        },
      ],
    },
    tooltip: { y: { formatter: (v) => inr(v) } },
  };

  return (
    <div className="card p-4">
      <div className="flex items-center justify-between">
        <div className="text-[15px] font-semibold">Analysis</div>
        <div className="muted text-sm">
          MTM:{" "}
          <span
            className={calc.metrics.mtm >= 0 ? "text-emerald-600" : "text-red-600"}
          >
            {inr(calc.metrics.mtm)}
          </span>{" "}
          | Spot: ₹ {spot.toLocaleString("en-IN")}
        </div>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-5 gap-3 my-4">
        <K label="Total MTM" v={inr(calc.metrics.mtm)} />
        <K label="Maximum Profit" v={inr(calc.metrics.maxProfit)} />
        <K label="Risk/Reward" v={calc.metrics.riskReward} />
        <K label="Maximum Loss" v={inr(calc.metrics.maxLoss)} />
        <K label="Margin Approx" v={inr(calc.metrics.margin)} />
        <K
          label="Breakeven"
          v={`${
            calc.metrics.breakevenValue
          }${
            calc.metrics.breakevenPercent !== "—"
              ? ` (${calc.metrics.breakevenPercent}%)`
              : ""
          }`}
        />
        <K label="Delta" v={fmtNum(calc.greeksAgg.delta, 3)} />
        <K label="Gamma" v={Number(calc.greeksAgg.gamma).toExponential(3)} />
        <K label="Theta" v={fmtNum(calc.greeksAgg.theta, 0)} />
        <K label="Vega" v={fmtNum(calc.greeksAgg.vega, 0)} />
      </div>

      <div className="w-full">
        {/* key forces re-render on theme change so Apex reskins */}
        <Chart key={themeKey} options={options} series={series} type="line" height={360} />
      </div>
    </div>
  );
}

/* --------- small UI helpers --------- */
function K({ label, v }) {
  return (
    <div className="p-3 rounded-lg bg-gray-50 dark:bg-blue-gray-800 border border-blue-gray-50/50 dark:border-blue-gray-700">
      <div className="muted text-[11px]">{label}</div>
      <div className="text-sm font-semibold">{v}</div>
    </div>
  );
}

function baseMetrics(realized = 0) {
  return {
    mtm: realized,
    maxProfit: 0,
    maxLoss: 0,
    riskReward: "NA",
    margin: 0,
    breakevenValue: "—",
    breakevenPercent: "—",
  };
}

function zeroGreeks() {
  return { delta: 0, gamma: 0, theta: 0, vega: 0 };
}

function approxMargin(legs, spot, lot) {
  // Simple heuristic margin approximation (adjust with broker margin API)
  let shortNotional = 0,
    longOffset = 0;
  for (const l of legs) {
    if (l.side === "SELL") {
      shortNotional += spot * lot * (l.lots || 1) * 0.15;
    } else {
      longOffset += Math.min(
        spot * lot * (l.lots || 1) * 0.08,
        shortNotional * 0.5
      );
    }
  }
  return Math.max(0, shortNotional - longOffset);
}

function fmtNum(n, dps = 2) {
  if (!isFinite(n)) return "—";
  return Number(n).toFixed(dps);
}
