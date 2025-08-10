import type { Server as IOServer } from "socket.io";

/**
 * Simple synthetic tick generator (NIFTY & VIX)
 * Replace with connectZerodhaTicks/connectDhanTicks when wiring real feeds.
 */
export function startSyntheticTicks(io: IOServer) {
  let price = 24400;
  let vix = 12.5;
  setInterval(() => {
    const drift = (Math.random() - 0.5) * 6;
    price = Math.max(5000, price + drift);
    const vixDrift = (Math.random() - 0.5) * 0.1;
    vix = Math.max(8, vix + vixDrift);
    io.emit("tick", { symbol: "NIFTY", price: Number(price.toFixed(2)), ts: Date.now() });
    io.emit("vix", { symbol: "INDIAVIX", value: Number(vix.toFixed(2)), ts: Date.now() });
  }, 1000);
}
