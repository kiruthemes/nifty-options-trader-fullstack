// app/src/hooks/useSocket.js
import { useEffect, useMemo, useRef, useState } from "react";
import { io } from "socket.io-client";
import { BACKEND_URL } from "../config";

/**
 * useSocket({ symbol, expiry, debounceMs })
 * - If symbol/expiry provided, the hook will (debounced) emit `oc:select`.
 * - Exposes live spot/futures and maps of live LTP/OI for the current chain so
 *   Dashboard can merge them with REST rows.
 */
export default function useSocket(opts = {}) {
  const { symbol = "NIFTY", expiry, debounceMs = 200 } = opts;

  const socketRef = useRef(null);

  // live spot & futures from provider
  const [spot, setSpot] = useState(undefined);
  const [fut, setFut] = useState(undefined);

  // per-chain live ticks (key = `${strike}|${type}` e.g. "24500|CE")
  const ltpRef = useRef(new Map()); // Map<string, number>
  const oiRef  = useRef(new Map()); // Map<string, number>

  // connection/feed status (so UI can show banners)
  const [status, setStatus] = useState("idle"); // idle | connected | reconnecting | disconnected

  // re-render bump when maps change
  const [, bump] = useState(0);
  const bumpNow = () => bump(v => (v + 1) & 0xffff);

  // remember what we last subscribed to (to avoid duplicate emits)
  const curSelRef = useRef({ symbol: undefined, expiry: undefined });
  const selTimerRef = useRef(null);

  // ----- helpers -----
  const keyFor = (strike, type) => `${Number(strike)}|${type}`;

  const emitSelect = (next) => {
    const s = socketRef.current;
    if (!s || !s.connected || !next.expiry) return;

    const prev = curSelRef.current;
    if (prev.symbol === next.symbol && prev.expiry === next.expiry) return;

    // clear live maps when chain changes (avoid showing stale ticks)
    ltpRef.current = new Map();
    oiRef.current  = new Map();
    bumpNow();

    s.emit("oc:select", next);
    curSelRef.current = next;
  };

  const selectChain = (sym, exp) => {
    if (selTimerRef.current) clearTimeout(selTimerRef.current);
    selTimerRef.current = setTimeout(() => {
      emitSelect({ symbol: String(sym || "NIFTY").toUpperCase(), expiry: String(exp) });
    }, debounceMs);
  };

  // ----- mount socket -----
  useEffect(() => {
    const s = io(BACKEND_URL, { transports: ["websocket"] });
    socketRef.current = s;

    s.on("connect", () => {
      setStatus("connected");
      // re-emit last desired selection on reconnect
      const want = {
        symbol: String(curSelRef.current.symbol || symbol || "NIFTY").toUpperCase(),
        expiry: curSelRef.current.expiry || expiry,
      };
      if (want.expiry) emitSelect(want);
    });

    s.on("disconnect", () => setStatus("disconnected"));
    s.on("reconnect_attempt", () => setStatus("reconnecting"));

    // Server -> status updates (from Dhan WS layer)
    s.on("feed:status", (st) => {
      if (st?.status) setStatus(st.status);
    });

    // Spot index ticks
    s.on("feed:spot", (t) => {
      const v = Number(t?.ltp);
      if (Number.isFinite(v)) setSpot(v);
    });

    // Futures ticks (explicit event from server)
    s.on("feed:fut", (t) => {
      const v = Number(t?.ltp);
      if (Number.isFinite(v)) {
        // console.debug("[WS] FUT", v);
        setFut(v);
      }
    });

    // Option (and any generic) ticks
    s.on("oc:tick", (t) => {
      const ltp = Number(t?.ltp);
      if (!Number.isFinite(ltp) || ltp <= 0) return;

      // If server ever sends a generic FUT tick without type/strike,
      // treat it as futures for safety.
      if (!t?.type && !Number.isFinite(Number(t?.strike)) && t?.symbol) {
        setFut(ltp);
        return;
      }

      // CE/PE ticks keyed by strike|type — replace Map to change identity
      const k = keyFor(t.strike, t.type);
      const next = new Map(ltpRef.current);
      next.set(k, ltp);
      ltpRef.current = next;
      bumpNow();
    });

    // OI packets (arrive less frequently) — replace Map to change identity
    s.on("oc:oi", (t) => {
      const oi = Number(t?.oi);
      if (!Number.isFinite(oi) || oi < 0) return;
      const k = keyFor(t.strike, t.type);
      const next = new Map(oiRef.current);
      next.set(k, oi);
      oiRef.current = next;
      bumpNow();
    });

    return () => {
      try { s.disconnect(); } catch {}
      socketRef.current = null;
      if (selTimerRef.current) clearTimeout(selTimerRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // auto (debounced) select when inputs change
  useEffect(() => {
    if (expiry) selectChain(symbol, expiry);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [symbol, expiry]);

  // stable getters to read latest maps
  const ltpMap = useMemo(() => ltpRef.current, [ltpRef.current]);
  const oiMap  = useMemo(() => oiRef.current,  [oiRef.current]);

  return {
    socket: socketRef.current,
    status, // "connected" | "reconnecting" | "disconnected" | "idle"
    spot,
    fut,    // live futures LTP from server
    ltpMap,
    oiMap,
    selectChain,
  };
}
