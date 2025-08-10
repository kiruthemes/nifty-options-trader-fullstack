/**
 * Dhan stubs — fill with real implementations later.
 * REST docs: https://api.dhan.co
 * WS docs: subscribe to streaming for ticks/option chain where available.
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

export async function placeOrderDhan(order: Order) {
  // Placeholder: log and return a fake id
  // TODO: Replace with actual Dhan REST call with Client-Id and Access-Token headers
  console.log("[DHAN] placeOrder", order);
  return { id: `dhan-${Date.now()}` };
}

export function connectDhanTicks(io: IOServer) {
  // TODO: Implement Dhan WS and emit io.emit('tick', payload)
  console.log("[DHAN] Ticker connection not yet implemented");
}
