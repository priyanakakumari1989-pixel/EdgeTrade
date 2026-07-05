import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { handleSyncRequest } from "../_utils/edge-handler.ts";
import { saveSyncedTrades, msToDate, msToTime, NormalizedTrade } from "../_utils/utils.ts";
import { hmacSha256Base64 } from "../_utils/crypto.ts";

async function htxFetch(path: string, params: Record<string, string>, apiKey: string, apiSecret: string) {
  const ts = new Date().toISOString().replace(/\..+/, "");
  const host = "api.huobi.pro"; // NOTE: verify when live - HTX rebrand may have shifted this domain
  const sorted = Object.entries({ ...params, AccessKeyId: apiKey, SignatureMethod: "HmacSHA256", SignatureVersion: "2", Timestamp: ts })
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join("&");
  const preSign = `GET
${host}
${path}
${sorted}`;
  const sig = await hmacSha256Base64(apiSecret, preSign);
  const res = await fetch(`https://${host}${path}?${sorted}&Signature=${encodeURIComponent(sig)}`);
  if (!res.ok) {
    console.error(`HTX API error [${path}] symbol=${params.symbol}: ${res.status} ${await res.text()}`);
    return null;
  }
  const j = await res.json();
  return j?.data || null;
}

serve((req) => handleSyncRequest(req, async (conn, supabase) => {
  const apiKey = conn.api_key_encrypted as string;
  const apiSecret = conn.api_secret_encrypted as string;
  const trades: NormalizedTrade[] = [];
  const startDate = new Date(Date.now() - 90 * 24 * 3600 * 1000).toISOString().split("T")[0];

  // NOTE: HTX's /v1/order/orders requires a "symbol" param (mandatory per docs) - the old code
  // never sent it, which likely caused the call to fail silently. Looping over common symbols
  // as a fix, similar to the MEXC pattern. Coverage gap same as MEXC - expand list as needed.
  const symbols = ["btcusdt","ethusdt","solusdt","xrpusdt","bnbusdt","dogeusdt","adausdt"];
  for (const symbol of symbols) {
    const orders = await htxFetch("/v1/order/orders", {
      symbol, "start-date": startDate, states: "filled", size: "500"
    }, apiKey, apiSecret);
    if (!Array.isArray(orders)) continue;

    for (const o of orders) {
      const ts = parseInt(o["finished-at"] || o["created-at"]);
      trades.push({
        external_trade_id: `htx-${o.id}`,
        symbol: symbol.toUpperCase().replace("USDT", "/USDT"),
        direction: o.type?.includes("buy") ? "long" : "short",
        lot_size: parseFloat(o["field-amount"] || o.amount),
        lot_unit: "qty",
        entry_price: parseFloat(o["field-cash-amount"] && o["field-amount"]
          ? (parseFloat(o["field-cash-amount"]) / parseFloat(o["field-amount"])).toFixed(8)
          : o.price),
        exit_price: null,
        entry_time: msToTime(ts),
        fees: parseFloat(o["field-fees"] || "0"),
        stop_loss: null,
        take_profit: null,
        conclusion: "breakeven",
        date: msToDate(ts),
      });
    }
  }

  return await saveSyncedTrades(supabase as never, conn.user_id as string, conn.id as string, trades);
}));
