import React, { useMemo, useState, useCallback } from "react";
import { inr } from "../utils/format.js";
import { bsPrice } from "../utils/bs.js";
import { DEFAULT_LOT_SIZE, DEFAULT_RF_RATE, DEFAULT_IV } from "../config.js";

/**
 * Props:
 *  - liveLegs: [{ side, type, strike, premium, lots, expiry? }]
 *  - stagedLegs: [{ side, type, strike, premium, lots, expiry? }]
 *  - spot, daysToExpiry, realized
 *  - defaultExpiry?: string (YYYY-MM-DD)
 *  - defaultLots?: number
 *  - onChangeDefaultLots?(n: number)
 *  - onUpdateStagedLots?(idx: number, n: number)
 *  - onSquareOff(idx), onSquareOffAll()
 *  - onPlaceOne(idx), onRemoveOne(idx), onPlaceAll(), onClearAll()
 */
export default function PositionsList({
  liveLegs = [],
  stagedLegs = [],
  spot,
  daysToExpiry = 5,
  realized = 0,
  defaultExpiry,
  defaultLots = 1,
  onChangeDefaultLots,
  onUpdateStagedLots,
  onSquareOff,
  onSquareOffAll,
  onPlaceOne,
  onRemoveOne,
  onPlaceAll,
  onClearAll,
}) {
  const t = Math.max(1 / 365, daysToExpiry / 365);
  const isBuy = (side) => String(side || "").toUpperCase() === "BUY";

  // ----- OPEN LEGS: compute live LTP + MTM -----
  const liveRows = useMemo(() => {
    return liveLegs.map((l) => {
      const type = l.type === "CE" ? "C" : "P";
      const ltpNow = bsPrice(spot, l.strike, DEFAULT_RF_RATE, DEFAULT_IV, t, type);
      const sign = isBuy(l.side) ? 1 : -1;
      const mtm = sign * (ltpNow - l.premium) * (l.lots || 1) * DEFAULT_LOT_SIZE;
      return { ...l, ltpNow, mtm };
    });
  }, [JSON.stringify(liveLegs), spot, daysToExpiry]);

  const unrealized = liveRows.reduce((a, r) => a + r.mtm, 0);
  const total = realized + unrealized;

  // ----- STAGED: cash preview -----
  const stagedRows = useMemo(() => {
    return stagedLegs.map((l) => {
      const signCash = isBuy(l.side) ? -1 : 1; // BUY -> debit
      const estCash = signCash * (l.premium || 0) * (l.lots || 1) * DEFAULT_LOT_SIZE;
      return { ...l, estCash };
    });
  }, [JSON.stringify(stagedLegs)]);

  // ----- CLOSED ROWS (kept in UI) -----
  const [closedRows, setClosedRows] = useState([]); // [{leg, exitPrice, realizedPnl}]
  const addClosedRow = useCallback((leg, exitPrice) => {
    const sign = isBuy(leg.side) ? 1 : -1;
    const realizedPnl = sign * (exitPrice - leg.premium) * (leg.lots || 1) * DEFAULT_LOT_SIZE;
    setClosedRows((prev) => [{ leg: { ...leg }, exitPrice, realizedPnl }, ...prev]);
  }, []);

  // LTP for closed rows continues to update (display only)
  const closedDisplayRows = useMemo(() => {
    return closedRows.map(({ leg, exitPrice, realizedPnl }) => {
      const type = leg.type === "CE" ? "C" : "P";
      const ltpNow = bsPrice(spot, leg.strike, DEFAULT_RF_RATE, DEFAULT_IV, t, type);
      // Notional P/L vs exit (analysis only)
      const sign = isBuy(leg.side) ? 1 : -1;
      const notionalPnl = sign * (ltpNow - exitPrice) * (leg.lots || 1) * DEFAULT_LOT_SIZE;
      return { leg, exitPrice, realizedPnl, ltpNow, notionalPnl };
    });
  }, [closedRows, spot, daysToExpiry]);

  // ---- Confirm-exit modal state ----
  const [exitIdx, setExitIdx] = useState(null);
  const openExitModal = (idx) => setExitIdx(idx);
  const closeExitModal = () => setExitIdx(null);

  // ---- Handlers ----
  const handleSquareOffOne = (idx) => {
    const row = liveRows[idx];
    if (!row) return onSquareOff?.(idx);
    addClosedRow(liveLegs[idx], row.ltpNow);
    onSquareOff?.(idx);
  };

  const handleSquareOffAll = () => {
    if (!liveRows.length) return;
    liveRows.forEach((row, i) => addClosedRow(liveLegs[i], row.ltpNow));
    onSquareOffAll?.();
  };

  const changeLots = (idx, val) => {
    const n = Math.max(1, Math.min(999, Number(val) || 1));
    onUpdateStagedLots?.(idx, n);
  };

  // data for modal (live estimate)
  const modalRow = exitIdx != null ? liveRows[exitIdx] : null;

  return (
    <div className="flex flex-col gap-6">
      {/* OPEN + CLOSED (same card) */}
      <div className="card p-3">
        <div className="flex items-center justify-between mb-2">
          <div className="text-lg font-semibold">Positions</div>
          <button
            className={`text-sm text-blue-600 ${liveLegs.length ? "opacity-100" : "opacity-50 cursor-not-allowed"}`}
            onClick={handleSquareOffAll}
            title="Square off all open positions"
          >
            Square off all →
          </button>
        </div>

        <div className="divide-y dark:divide-blue-gray-800">
          {liveRows.length === 0 && closedDisplayRows.length === 0 && (
            <div className="muted py-6">No positions.</div>
          )}

          {/* OPEN rows */}
          {liveRows.map((l, idx) => (
            <div key={`live-${idx}`} className="py-2">
              <div className="grid grid-cols-[auto_1fr_auto_auto] items-center gap-3">
                <span className={`dot ${isBuy(l.side) ? "dot-buy" : "dot-sell"}`} aria-hidden />
                <div className="min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <div className="font-medium truncate">
                      {String(l.side).toUpperCase()} {l.type} {l.strike}
                    </div>
                    <div className="text-xs muted">{fmtExpiry(l.expiry || defaultExpiry)}</div>
                    {/* lots as a pill ONLY for open positions */}
                    <span className="pill">{(l.lots || 1)} lots</span>
                  </div>
                  <div className="text-xs muted mt-0.5">
                    Avg: {inr(l.premium)} • LTP: {inr(l.ltpNow)}
                  </div>
                </div>

                <div
                  className={`text-right tabular-nums ${l.mtm >= 0 ? "text-green-600" : "text-red-600"}`}
                  style={{ width: 120 }}
                >
                  {inr(l.mtm)}
                </div>

                {/* Exit icon */}
                <div className="flex justify-end" style={{ width: 44 }}>
                  <button
                    className="icon-btn"
                    title="Exit leg"
                    onClick={() => openExitModal(idx)}
                    aria-label="Exit"
                  >
                    <svg width="18" height="18" viewBox="0 0 24 24" stroke="currentColor" fill="none">
                      <path strokeWidth="2" d="M10 17l5-5-5-5" />
                      <path strokeWidth="2" d="M4 12h11" />
                      <path strokeWidth="2" d="M19 4v16" opacity=".35" />
                    </svg>
                  </button>
                </div>
              </div>
            </div>
          ))}

          {/* CLOSED rows (greyed, keep updating LTP; show Entry/Exit/Realized + Notional) */}
          {closedDisplayRows.length > 0 && (
            <div className="pt-2">
              {closedDisplayRows.map(({ leg, exitPrice, realizedPnl, ltpNow, notionalPnl }, i) => {
                const realizedClass = realizedPnl >= 0 ? "text-green-600" : "text-red-600";
                const notionalClass = notionalPnl >= 0 ? "text-green-600" : "text-red-600";
                return (
                  <div key={`closed-${i}`} className="py-2 opacity-60">
                    <div className="grid grid-cols-[auto_1fr_auto_auto] items-center gap-3">
                      <span className={`dot ${isBuy(leg.side) ? "dot-buy" : "dot-sell"}`} aria-hidden />
                      <div className="min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <div className="font-medium truncate">
                            {String(leg.side).toUpperCase()} {leg.type} {leg.strike}
                          </div>
                          <div className="text-xs muted">{fmtExpiry(leg.expiry || defaultExpiry)}</div>
                          <span className="pill">{(leg.lots || 1)} lots</span>
                        </div>
                        <div className="text-xs muted mt-0.5">
                          Entry: {inr(leg.premium)} • Exit: {inr(exitPrice)} • LTP: {inr(ltpNow)}
                        </div>
                      </div>

                      {/* Realized with notional-in-parentheses (analysis only) */}
                      <div className="text-right tabular-nums" style={{ width: 180 }}>
                        <span className={realizedClass}>{inr(realizedPnl)}</span>{" "}
                        <span className="text-xs muted">
                          (
                          <span className={notionalClass}>{inr(notionalPnl)}</span>
                          )
                        </span>
                      </div>

                      <div style={{ width: 44 }} />
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        <div className="flex items-center justify-between mt-3 pt-2 border-t dark:border-blue-gray-800">
          <div className="muted text-sm">
            Realised <b>{inr(realized)}</b> • Unrealized <b>{inr(unrealized)}</b>
          </div>
          <div className="text-sm">Total {inr(total)}</div>
        </div>
      </div>

      {/* STAGED ORDERS */}
      <div className="card p-3">
        <div className="flex items-center justify-between mb-2">
          <div className="text-lg font-semibold">Staged Orders (Not Placed)</div>

          {/* Default lots (clean field only) */}
          <div className="flex items-center gap-2">
            <label className="text-xs muted" htmlFor="default-lots">
              Default lots
            </label>
            <input
              id="default-lots"
              type="number"
              min={1}
              max={999}
              value={Number(defaultLots) || 1}
              onChange={(e) => {
                const n = Math.max(1, Math.min(999, Number(e.target.value) || 1));
                onChangeDefaultLots?.(n);
              }}
              className="chip-input w-20 text-center"
              placeholder="1"
            />

            <button
              className={`btn btn-success ${stagedRows.length ? "" : "opacity-50 cursor-not-allowed"}`}
              onClick={() => stagedRows.length && onPlaceAll?.()}
              title="Place all staged orders"
            >
              Place all
            </button>
            <button
              className={`btn btn-muted ${stagedRows.length ? "" : "opacity-50 cursor-not-allowed"}`}
              onClick={() => stagedRows.length && onClearAll?.()}
              title="Clear all staged orders"
            >
              Clear
            </button>
          </div>
        </div>

        <div className="divide-y dark:divide-blue-gray-800">
          {stagedRows.length === 0 && (
            <div className="muted py-6">
              No staged orders. Click <b>Buy/Sell</b> from the Option Chain to stage legs without placing.
            </div>
          )}

          {stagedRows.map((l, idx) => (
            <div key={`staged-${idx}`} className="py-2">
              <div className="grid grid-cols-[auto_1fr_auto_auto] items-center gap-3">
                <span className={`dot ${isBuy(l.side) ? "dot-buy" : "dot-sell"}`} aria-hidden />
                <div className="min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <div className="font-medium truncate">
                      {String(l.side).toUpperCase()} {l.type} {l.strike}
                    </div>
                    <div className="text-xs muted">{fmtExpiry(l.expiry || defaultExpiry)}</div>

                    {/* Editable lots (NOT a pill) */}
                    <div className="flex items-center gap-1 text-xs">
                      <span className="muted">Lots</span>
                      <input
                        type="number"
                        min={1}
                        max={999}
                        value={Number(l.lots || 1)}
                        onChange={(e) => {
                          const n = Math.max(1, Math.min(999, Number(e.target.value) || 1));
                          onUpdateStagedLots?.(idx, n);
                        }}
                        className="w-16 h-7 text-center rounded border dark:border-blue-gray-700 bg-white dark:bg-blue-gray-900"
                      />
                    </div>
                  </div>

                  <div className="text-xs muted mt-0.5">
                    Price: {inr(l.premium)} • {isBuy(l.side) ? "Debit" : "Credit"}: <b>{inr(l.estCash)}</b>
                  </div>
                </div>

                <div className="text-right text-xs muted" style={{ width: 120 }} />
                <div className="flex justify-end gap-2" style={{ width: 200 }}>
                  <button className="btn btn-success" onClick={() => onPlaceOne?.(idx)}>
                    Place
                  </button>
                  <button className="btn btn-muted" onClick={() => onRemoveOne?.(idx)}>
                    Remove
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>

        {stagedRows.length > 0 && (
          <div className="mt-3 pt-2 border-t dark:border-blue-gray-800 text-sm muted">
            Staged legs already affect the payoff graph, but won’t be sent to your broker until you hit <b>Place</b>.
          </div>
        )}
      </div>

      {/* Confirm Exit Modal */}
      {exitIdx != null && modalRow && (
        <ConfirmExitModal
          leg={liveLegs[exitIdx]}
          ltp={modalRow.ltpNow}
          mtm={modalRow.mtm}
          onCancel={closeExitModal}
          onConfirm={() => {
            handleSquareOffOne(exitIdx);
            closeExitModal();
          }}
        />
      )}
    </div>
  );
}

/* helpers */
function fmtExpiry(code) {
  if (!code) return "—";
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(code));
  if (!m) return code;
  const [_, y, mo, d] = m;
  const dt = new Date(`${y}-${mo}-${d}T12:00:00Z`);
  const fmt = dt.toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" });
  return fmt;
}

/* Modal component */
function ConfirmExitModal({ leg, ltp, mtm, onCancel, onConfirm }) {
  if (!leg) return null;
  const side = String(leg.side).toUpperCase();
  return (
    <div className="fixed inset-0 z-50">
      <div className="absolute inset-0 bg-black/50" onClick={onCancel} />
      <div className="absolute inset-0 flex items-center justify-center p-4">
        <div className="w-full max-w-md rounded-2xl bg-white dark:bg-blue-gray-900 border border-gray-200 dark:border-blue-gray-800 shadow-2xl">
          <div className="px-4 py-3 border-b dark:border-blue-gray-800 flex items-center justify-between">
            <div className="text-sm font-semibold">Confirm Exit</div>
            <button className="icon-btn" onClick={onCancel} aria-label="Close">
              <svg width="18" height="18" viewBox="0 0 24 24" stroke="currentColor" fill="none">
                <path strokeWidth="2" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>

          <div className="p-4 space-y-3">
            <div className="text-sm">
              Exit{" "}
              <b>
                {side} {leg.type} {leg.strike}
              </b>{" "}
              {leg.expiry ? `(${fmtExpiry(leg.expiry)})` : ""} — {leg.lots || 1} lots?
            </div>

            <div className="text-xs muted">
              Entry: <b>{inr(leg.premium)}</b> • LTP: <b>{inr(ltp)}</b> • Est. P&L:{" "}
              <b className={mtm >= 0 ? "text-green-600" : "text-red-600"}>{inr(mtm)}</b>
            </div>

            <div className="flex items-center justify-end gap-2 pt-2">
              <button className="btn btn-muted" onClick={onCancel}>
                Cancel
              </button>
              <button className="btn btn-primary" onClick={onConfirm}>
                Exit position
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
