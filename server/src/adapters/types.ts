// server/src/adapters/types.ts
export type Provider = "synthetic" | "dhan" | "kite";

export interface OptionChainRow {
  strike: number;
  callLtp: number;
  putLtp: number;
  callOi: number;
  putOi: number;
  iv: number;
}

export interface MarketAdapter {
  name: Provider;
  getOptionChain(symbol: string, expiry: string): Promise<OptionChainRow[]>;
  // Optional: live ticks hookup later
  connectTicks?: (io: import("socket.io").Server) => void;
}

export interface PlaceOrderRequest {
  symbol: string;      // NIFTY, BANKNIFTY
  exchange: string;    // NFO
  product: string;     // NRML
  order_type: string;  // MARKET/LIMIT
  side: string;        // BUY/SELL
  option_type: string; // CE/PE
  strike: number;
  price?: number;
  lots: number;
  lot_size: number;
  expiry: string;
  action: string;      // OPEN/CLOSE
}

export interface ExecutionAdapter {
  name: Provider;
  placeOrder(req: PlaceOrderRequest, creds: {
    apiKey?: string | null;
    apiSecret?: string | null;
    accessToken?: string | null;
  }): Promise<{ ok: boolean; orderId?: string; raw?: any }>;
}
