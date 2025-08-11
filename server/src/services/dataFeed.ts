// server/src/services/dataFeed.ts
import { Server } from "socket.io";
import { MarketAdapter, Provider } from "../adapters/types";
import { DhanMarket } from "../adapters/dhan";
import { KiteMarket } from "../adapters/zerodha";

type State = {
  provider: Provider;
  adapter: MarketAdapter;
};

const providers: Record<Provider, MarketAdapter> = {
  synthetic: {
    name: "synthetic",
    getOptionChain: async (_symbol: string, _expiry: string) => {
      // Synthetic returns empty; FE falls back to its local generator
      return [];
    },
  },
  dhan: DhanMarket,
  kite: KiteMarket,
};

const state: State = {
  provider: (process.env.DATA_SOURCE as Provider) || "synthetic",
  adapter: providers[(process.env.DATA_SOURCE as Provider) || "synthetic"],
};

export function getProvider(): Provider {
  return state.provider;
}

export function setProvider(p: Provider) {
  if (!providers[p]) return;
  state.provider = p;
  state.adapter = providers[p];
}

export async function fetchOptionChain(symbol: string, expiry: string) {
  return state.adapter.getOptionChain(symbol, expiry);
}

export function wireTicks(_io: Server) {
  // For later: wire Dhan/Zerodha live WS
  // providers[state.provider].connectTicks?.(_io);
}
