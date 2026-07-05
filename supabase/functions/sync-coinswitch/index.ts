// IMPORTANT: CoinSwitch PRO API requires every private request to be signed with an Ed25519
// private key (NOT HMAC like every other broker here). The old version of this file sent no
// signature at all - every request was likely being rejected by CoinSwitch's servers.
// Message format and endpoint are based on CoinSwitch's official onboarding docs, but this
// has NOT been live-tested yet. After first deploy, check Supabase function logs carefully -
// if requests fail, the error message will usually indicate whether it's a signature mismatch,
// wrong endpoint, or wrong param format.

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { handleSyncRequest } from "../_utils/edge-handler.ts";
import { saveSyncedTrades, msToDate, msToTime, NormalizedTrade } from "../_utils/utils.ts";
import { ed25519SignHex } from "../_utils/crypto.ts";

async function coinswitchFetch(path: string, params: Record<string, string | number | boolean>, apiKey: string, apiSecret: string) {
  const epoch = Date.now().toString();
  const qstr = new URLSearchParams(
    Object.fromEntries(Object.entries(params).map(([k, v]) => [k, String(v)]))
  ).toString();
  const fullPath = qstr ? `${path}?${qstr}` : path;
  const message = epoch + "GET" + fullPath;
  const signature = await ed25519SignHex(apiSecret, message);

  const res = await fetch(`https://coinswitch.co${fullPath}`, {
    headers: {
      "X-AUTH-APIKEY": apiKey,
      "X-AUTH-SIGNATURE": signature,
      "X-AUTH-EPOCH": epoch,
      "Content-Type": "application/json",
    }
  });
  if (!res.ok) {
    console.error(`CoinSwitch API error [${path}]: ${res.status} ${await res.text()}`);
    return null;
  }
  const j = await res.json();
  return j?.data || j?.orders || null;
}

serve((req) => handleSyncRequest(req, async (conn, supabase) => {
  const apiKey = conn.api_key_encrypted as string;
  const apiSecret = conn.api_secret_encrypted as string; // this must be the Ed25519 private key (hex), not an HMAC secret
  const trades: NormalizedTrade[] = [];

  const from_time = Date.now() - 90 * 24 * 3600 * 1000;
  const to_time = Date.now();

  const orders = await coinswitchFetch("/api/v2/orders", {
    open: false, from_time, to_time, count: 500
  }, apiKey, apiSecret);

  const orderList = Array.isArray(orders) ? orders : (orders?.orders || null);
  if (Array.isArray(orderList)) {
    for (const o of orderList) {
      // NOTE: verify when live - exact field names for this endpoint aren't confirmed
      // from public docs, only the request/signing shape. Adjust field names below after
      // checking the first real response in Supabase logs (console.error the raw response
      // temporarily if needed).
      if (o.status && !["EXECUTED", "FILLED", "closed"].includes(o.status)) continue;
      const ts = new Date(o.created_at || o.updated_at || o.timestamp).getTime();
      trades.push({
        external_trade_id: `csw-${o.order_id || o.id}`,
        symbol: (o.symbol || o.trading_pair || "").replace("/", "/").toUpperCase(),
        direction: (o.side || "").toUpperCase() === "BUY" ? "long" : "short",
        lot_size: parseFloat(o.quantity || o.executed_quantity || "0"),
        lot_unit: "qty",
        entry_price: parseFloat(o.price || o.average_price || "0"),
        exit_price: null,
        entry_time: msToTime(ts),
        fees: parseFloat(o.fee || o.fees || "0"),
        stop_loss: null,
        take_profit: null,
        conclusion: "breakeven",
        date: msToDate(ts),
      });
    }
  }

  return await saveSyncedTrades(supabase as never, conn.user_id as string, conn.id as string, trades);
}));
