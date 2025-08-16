// server/src/services/brokerExec.ts
import prisma from "../db";
import { getBrokerSecrets, redact } from "../utils/vault";
import fetch from "node-fetch";

/**
 * Normalized order shape (what your UI already sends to /trade or similar)
 */
export type NormalizedOrder = {
  symbol: string;         // "NIFTY"
  exchange: string;       // "NFO"
  product: string;        // "NRML" | "MIS" | etc.
  order_type: string;     // "MARKET" | "LIMIT"
  side: "BUY" | "SELL";
  option_type: "CE" | "PE";
  strike: number;
  price?: number;         // for LIMIT; used as reference even for MARKET logs
  lots: number;
  lot_size: number;       // e.g., 75
  expiry: string;         // "YYYY-MM-DD"
  expiryDate?: string;    // alias
  action?: "OPEN" | "CLOSE" | string;
};

/**
 * Adapter interface — providers (dhan, kite) must implement this.
 * send() should place a *single* order.
 */
interface BrokerAdapter {
  name: string;
  send(
    order: NormalizedOrder,
    secrets: ReturnType<typeof getBrokerSecrets>
  ): Promise<{ providerOrderId?: string; raw?: any }>;
}

/**
 * Simulation mode
 * Set BROKER_SIMULATE=false in production to enable real sends (once adapters are filled).
 */
const SIMULATE = String(process.env.BROKER_SIMULATE ?? "true").toLowerCase() !== "false";

/* ---------------- Provider Adapters ---------------- */

// Dhan adapter (skeleton)
const dhanAdapter: BrokerAdapter = {
  name: "dhan",
  async send(order, secrets) {
    if (SIMULATE) {
      // pretend success
      return {
        providerOrderId: `SIM-DHAN-${Date.now()}`,
        raw: { note: "simulation", order, secrets: { accessToken: redact(secrets.accessToken) } },
      };
    }

    // Map NormalizedOrder -> Dhan v2 order payload
    // Docs: https://dhanhq.co/docs/v2/orders/
    const side = order.side === "BUY" ? "BUY" : "SELL";
    const orderType = order.order_type === "LIMIT" ? "LIMIT" : "MARKET";
    const productType = (process.env.DHAN_PRODUCT_TYPE || order.product || "CNC").toUpperCase();
    // Dhan expects securityId; we support symbol/strike/expiry via server-side mapping ideally.
    // For MVP, rely on option tradingSymbol if provided via secrets.meta or order.action payload; otherwise send error.
    const meta = secrets.meta || {};
    const securityId = meta.securityId || meta.secId;
    if (!securityId) {
      throw new Error("Dhan securityId missing for order. Attach via BrokerAccount.metaJson");
    }

    const body: any = {
      transactionType: side, // BUY/SELL
      exchangeSegment: "NSE_FNO", // F&O by default for options
      productType, // CNC for delivery as requested
      orderType, // MARKET/LIMIT
      validity: "DAY",
      securityId,
      quantity: Math.max(1, Number(order.lots || 1)) * Math.max(1, Number(order.lot_size || 1)),
      disclosedQuantity: 0,
    };
    if (orderType === "LIMIT" && Number.isFinite(Number(order.price))) body.price = Number(order.price);

    const url = (process.env.DHAN_API_BASE || "https://api.dhan.co") + "/orders";
    const headers: any = {
      "Content-Type": "application/json",
      "Client-Id": (process.env.DHAN_CLIENT_ID || secrets.clientId || "").trim(),
      "Access-Token": (secrets.accessToken || process.env.DHAN_ACCESS_TOKEN || "").trim(),
    };
    if (!headers["Access-Token"]) throw new Error("Dhan access token missing");
    if (!headers["Client-Id"]) throw new Error("Dhan client id missing");

    const resp = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
    const data: any = await resp.json().catch(() => ({} as any));
    if (!resp.ok) {
      throw new Error((data && (data.message || data.error)) || `Dhan order failed (${resp.status})`);
    }
    const providerOrderId = (data && (data.orderId || (data.data && data.data.orderId))) || undefined;
    return { providerOrderId, raw: data };
  },
};

// Zerodha/Kite adapter (skeleton)
const kiteAdapter: BrokerAdapter = {
  name: "kite",
  async send(order, secrets) {
    if (SIMULATE) {
      return {
        providerOrderId: `SIM-KITE-${Date.now()}`,
        raw: {
          note: "simulation",
          order,
          secrets: { apiKey: redact(secrets.apiKey), apiSecret: redact(secrets.apiSecret) },
        },
      };
    }

    // TODO: Implement real Kite order placement:
    // - Use apiKey/apiSecret to complete session/auth and obtain accessToken (or expect one pre-supplied).
    // - Place order via Kite Order API.
    // return { providerOrderId, raw };

    throw new Error("Kite adapter not implemented (set BROKER_SIMULATE=true for dev).");
  },
};

function getAdapter(provider: string): BrokerAdapter {
  const p = provider.toLowerCase();
  if (p === "dhan") return dhanAdapter;
  if (p === "kite") return kiteAdapter;
  throw new Error(`Unsupported provider: ${provider}`);
}

/* ---------------- Fanout Orchestrator ---------------- */

/**
 * Place an array of normalized orders for *all linked brokers* on a strategy.
 * - Records each order in the Orders table
 * - Updates status on success/failure
 * - Returns a result per broker per order
 */
export async function placeOrdersForStrategy(
  strategyId: number,
  orders: NormalizedOrder[],
) {
  if (!strategyId) throw new Error("strategyId is required");
  if (!Array.isArray(orders) || orders.length === 0) return [];

  // Find enabled links + broker creds for this strategy
  const links = await prisma.strategyBroker.findMany({
    where: { strategyId, enabled: true, strategy: { userId: { not: undefined } } },
    include: {
      broker: true, // includes secrets
    },
  });

  const results: Array<{
    brokerAccountId: number;
    provider: string;
    perOrder: Array<{ ok: boolean; orderId?: number; providerOrderId?: string; error?: string }>;
  }> = [];

  for (const link of links) {
    const acct = link.broker;
    const provider = acct.provider.toLowerCase();
    const adapter = getAdapter(provider);
    const secrets = getBrokerSecrets(acct);

    const perOrder: Array<{ ok: boolean; orderId?: number; providerOrderId?: string; error?: string }> = [];

    for (const ord of orders) {
      // 1) Create DB row as PENDING
      const orderRow = await prisma.order.create({
        data: {
          strategyId,
          legId: null,
          brokerAccountId: acct.id,
          provider,
          status: "PENDING",
          requestJson: JSON.stringify(ord),
          responseJson: "{}",
        },
      });

      try {
        // 2) Send to provider
        const resp = await adapter.send(ord, secrets);

        // 3) Update DB row as OPEN/FILLED (let’s mark OPEN in general; fill events can update later)
        await prisma.order.update({
          where: { id: orderRow.id },
          data: {
            providerOrderId: resp.providerOrderId || null,
            status: SIMULATE ? "FILLED" : "OPEN",
            responseJson: JSON.stringify(resp.raw || {}),
          },
        });

        perOrder.push({ ok: true, orderId: orderRow.id, providerOrderId: resp.providerOrderId });
      } catch (err: any) {
        // 4) REJECTED
        await prisma.order.update({
          where: { id: orderRow.id },
          data: {
            status: "REJECTED",
            responseJson: JSON.stringify({ error: String(err?.message || err) }),
          },
        });
        perOrder.push({ ok: false, orderId: orderRow.id, error: String(err?.message || err) });
      }
    }

    results.push({ brokerAccountId: acct.id, provider, perOrder });
  }

  return results;
}
