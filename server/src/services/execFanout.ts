// server/src/services/execFanout.ts
import prisma from "../db";
import { DhanExec } from "../adapters/dhan";
import { KiteExec } from "../adapters/zerodha";
import { PlaceOrderRequest } from "../adapters/types";

export async function fanoutPlaceOrders(
  userId: number,
  strategyId: number,
  orders: PlaceOrderRequest[]
) {
  // read linked brokers for the strategy
  const links = await prisma.strategyBroker.findMany({
    where: { strategyId, enabled: true, strategy: { userId } },
    include: { broker: true },
  });

  const results: any[] = [];
  for (const link of links) {
    const provider = (link.broker.provider || "").toLowerCase();
    const exec = provider === "dhan" ? DhanExec : provider === "kite" ? KiteExec : null;
    if (!exec) continue;

    for (const ord of orders) {
      const r = await exec.placeOrder(ord, {
        apiKey: link.broker.apiKey,
        apiSecret: link.broker.apiSecret,
        accessToken: link.broker.accessToken,
      });

      // persist Order row
      await prisma.order.create({
        data: {
          strategyId,
          legId: null,
          brokerAccountId: link.broker.id,
          provider: exec.name,
          providerOrderId: r.orderId || null,
          status: r.ok ? "PENDING" : "REJECTED",
          requestJson: JSON.stringify(ord),
          responseJson: JSON.stringify(r.raw || {}),
        },
      });

      results.push({ brokerId: link.broker.id, provider: exec.name, ...r });
    }
  }
  return results;
}
