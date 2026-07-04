import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { handleSyncRequest } from "../_utils/edge-handler.ts";
import { saveSyncedTrades, pnlToConclusion, NormalizedTrade } from "../_utils/utils.ts";
import { hmacSha256Hex } from "../_utils/crypto.ts";

async function deltaFetch(base: string, path: string, params: Record<string, string | number>, apiKey: string, apiSecret: string) {
  const ts = Math.floor(Date.now() / 1000).toString();
  const method = "GET";
  const qstr = Object.keys(params).length ? new URLSearchParams(params as Record<string, string>).toString() : "";
  const body = "";
  const preSign = method + ts + path + (qstr ? "?" + qstr : "") + body;
  const sig = await hmacSha256Hex(apiSecret, preSign);
  const res = await fetch(`${base}${path}${qstr ? "?" + qstr : ""}`, {
    headers: { "api-key": apiKey, "signature": sig, "timestamp": ts }
  });
  if (!res.ok) {
    console.error("Delta API error:", res.status, await res.text());
    return null;
  }
  const j = await res.json();
  return j?.result || null;
}

serve((req) => handleSyncRequest(req, async (conn, supabase) => {
  const apiKey = conn.api_key_encrypted as string;
  const apiSecret = conn.api_secret_encrypted as string;
  const isDemo = conn.account_type === "demo";
  const base = isDemo ? "https://cdn-ind.testnet.deltaex.org" : "https://api.india.delta.exchange";
  const trades: NormalizedTrade[] = [];
  const cutoffMs = Date.now() - 90 * 24 * 3600 * 1000;

  const orders = await deltaFetch(base, "/v2/orders/history", { page_size: "50" }, apiKey, apiSecret);
  if (Array.isArray(orders)) {
    for (const o of orders) {
      if (o.state !== "closed" || !o.average_fill_price) continue;
      const ts = new Date(o.updated_at || o.created_at);
      if (ts.getTime() < cutoffMs) continue;
      const meta = o.meta_data || {};
      const pnl = parseFloat(meta.pnl || "0");
      const entryPrice = parseFloat(meta.entry_price || o.average_fill_price);
      const exitPrice = meta.avg_exit_price ? parseFloat(meta.avg_exit_price) : null;
      trades.push({
        external_trade_id: `delta-${o.id}`,
        symbol: (o.product?.symbol || o.product_symbol || "UNKNOWN").replace("USDT", "/USDT").replace("USD", "/USD").replace("INR", "/INR"),
        direction: o.side === "buy" ? "long" : "short",
        lot_size: parseFloat(o.size),
        lot_unit: "qty",
        entry_price: entryPrice,
        exit_price: exitPrice,
        entry_time: ts.toTimeString().slice(0, 5),
        fees: parseFloat(o.paid_commission || "0"),
        stop_loss: null,
        take_profit: null,
        conclusion: pnlToConclusion(pnl !== 0 ? pnl : null),
        date: ts.toISOString().split("T")[0],
      });
    }
  }

  return await saveSyncedTrades(supabase as never, conn.user_id as string, conn.id as string, trades);
}));
