// src/utils/api.js
import { BACKEND_URL } from "../config.js";

export async function placeOrders(orders) {
  const res = await fetch(`${BACKEND_URL}/api/place-order`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ orders }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json(); // { ok, accepted, result? }
}
