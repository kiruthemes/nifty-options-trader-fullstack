/**
 * Zerodha (Kite) stubs — fill with real implementations later.
 * For REST orders, you'll use Kite Connect's orders endpoint with appropriate headers.
 * For live ticks, use Kite Ticker SDK to subscribe to instrument tokens and emit to socket.io.
 */
import type { Server as IOServer } from "socket.io";
import fetch from "node-fetch";

type Order = {
  symbol: string;
  exchange: string;
  product: string;
  order_type: string;
  side: "BUY" | "SELL";
  option_type?: "CE" | "PE";
  strike?: number;
  price?: number;
  lots: number;
  lot_size?: number;
  action?: "OPEN" | "CLOSE";
};

export async function placeOrderZerodha(order: Order) {
  // Placeholder: log and return a fake id
  // TODO: Replace with actual Kite REST calls using API key + access token
  console.log("[ZERODHA] placeOrder", order);
  return { id: `kite-${Date.now()}` };
}

export function connectZerodhaTicks(io: IOServer) {
  // TODO: Implement using kiteconnect ticker client and io.emit('tick', payload)
  console.log("[ZERODHA] Ticker connection not yet implemented");
}
