import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { handleSyncRequest } from "../_utils/edge-handler.ts";
import { saveSyncedTrades, msToDate, msToTime, NormalizedTrade } from "../_utils/utils.ts";
import { hmacSha256Hex } from "../_utils/crypto.ts";

async function mexcFetch(path: string, params: Record<string, string | number>, apiKey: string, apiSecret: string) {
  const ts = Date.now();
  const allParams = { ...params, timestamp: ts };
  const qstr = Object.entries(allParams).map(([k, v]) => `${k}=${v}`).join("&");
  const sig = await hmacSha256Hex(apiSecret, qstr);
  const res = await fetch(`https://api.mexc.com${path}?${qstr}&signature=${sig}`, {
    headers: { "X-MEXC-APIKEY": apiKey }
  });
  if (!res.ok) {
    console.error(`MEXC API error [${path}] symbol=${params.symbol}: ${res.status} ${await res.text()}`);
    return null;
  }
  const j = await res.json();
  return Array.isArray(j) ? j : (j?.data || null);
}

serve((req) => handleSyncRequest(req, async (conn, supabase) => {
  const apiKey = conn.api_key_encrypted as string;
  const apiSecret = conn.api_secret_encrypted as string;
  const trades: NormalizedTrade[] = [];
  const startTime = Date.now() - 90 * 24 * 3600 * 1000;

  // NOTE: MEXC myTrades requires a symbol param - there is no "all symbols" endpoint,
  // so we're limited to this list. Flagged as a coverage gap - trades on symbols not
  // listed here will not sync. Expand this list as needed.
  const symbols = ["BTCUSDT","ETHUSDT","SOLUSDT","XRPUSDT","BNBUSDT","DOGEUSDT","ADAUSDT","AVAXUSDT","LINKUSDT","LTCUSDT"];
  for (const symbol of symbols) {
    const orders = await mexcFetch("/api/v3/myTrades", { symbol, startTime, limit: 1000 }, apiKey, apiSecret);
    if (!Array.isArray(orders)) continue;
    for (const o of orders) {
      const ts = parseInt(o.time);
      trades.push({
        external_trade_id: `mexc-${o.id}`,
        symbol: symbol.replace("USDT", "/USDT"),
        direction: o.isBuyer ? "long" : "short",
        lot_size: parseFloat(o.qty),
        lot_unit: "qty",
        entry_price: parseFloat(o.price),
        exit_price: null,
        entry_time: msToTime(ts),
        fees: parseFloat(o.commission),
        stop_loss: null,
        take_profit: null,
        conclusion: "breakeven",
        date: msToDate(ts),
      });
    }
  }

  return await saveSyncedTrades(supabase as never, conn.user_id as string, conn.id as string, trades);
}));
