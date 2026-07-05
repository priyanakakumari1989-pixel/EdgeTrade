import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { handleSyncRequest } from "../_utils/edge-handler.ts";
import { saveSyncedTrades, pnlToConclusion, NormalizedTrade } from "../_utils/utils.ts";
import { hmacSha256Hex } from "../_utils/crypto.ts";

async function coinbaseFetch(path: string, apiKey: string, apiSecret: string) {
  const ts = Math.floor(Date.now() / 1000).toString();
  const preSign = ts + "GET" + path;
  const sig = await hmacSha256Hex(apiSecret, preSign);
  const res = await fetch(`https://api.coinbase.com${path}`, {
    headers: {
      "CB-ACCESS-KEY": apiKey, "CB-ACCESS-SIGN": sig,
      "CB-ACCESS-TIMESTAMP": ts, "CB-VERSION": "2016-02-18",
    }
  });
  if (!res.ok) {
    console.error(`Coinbase API error [${path}]: ${res.status} ${await res.text()}`);
    return null;
  }
  return await res.json();
}

serve((req) => handleSyncRequest(req, async (conn, supabase) => {
  const apiKey = conn.api_key_encrypted as string;
  const apiSecret = conn.api_secret_encrypted as string;
  const trades: NormalizedTrade[] = [];
  const start = new Date(Date.now() - 90 * 24 * 3600 * 1000).toISOString();

  let cursor = "";
  let pages = 0;
  while (pages < 5) {
    const qs = `order_status=FILLED&start_date=${encodeURIComponent(start)}&limit=250${cursor ? `&cursor=${cursor}` : ""}`;
    const res = await coinbaseFetch(`/api/v3/brokerage/orders/historical/batch?${qs}`, apiKey, apiSecret);
    const orders = res?.orders;
    if (!Array.isArray(orders) || orders.length === 0) break;

    for (const o of orders) {
      const ts = new Date(o.last_fill_time || o.created_time);
      const pnl = parseFloat(o.total_value_after_fees || "0") - parseFloat(o.total_fees || "0");
      trades.push({
        external_trade_id: `coinbase-${o.order_id}`,
        symbol: (o.product_id || "").replace("-", "/"),
        direction: o.side === "BUY" ? "long" : "short",
        lot_size: parseFloat(o.filled_size || o.base_size || "0"),
        lot_unit: "qty",
        entry_price: parseFloat(o.average_filled_price || o.limit_price || "0"),
        exit_price: null,
        entry_time: ts.toTimeString().slice(0, 5),
        fees: parseFloat(o.total_fees || "0"),
        stop_loss: null,
        take_profit: null,
        conclusion: pnlToConclusion(pnl !== 0 ? pnl : null),
        date: ts.toISOString().split("T")[0],
      });
    }

    if (!res?.has_next || !res?.cursor) break;
    cursor = res.cursor;
    pages++;
  }

  return await saveSyncedTrades(supabase as never, conn.user_id as string, conn.id as string, trades);
}));
