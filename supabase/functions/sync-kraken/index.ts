import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { handleSyncRequest } from "../_utils/edge-handler.ts";
import { saveSyncedTrades, pnlToConclusion, msToDate, msToTime, NormalizedTrade } from "../_utils/utils.ts";
import { hmacSha256Hex } from "../_utils/crypto.ts";

async function krakenFetch(path: string, data: Record<string, string>, apiKey: string, apiSecret: string) {
  const nonce = Date.now().toString();
  const body = new URLSearchParams({ nonce, ...data }).toString();
  const enc = new TextEncoder();
  const secretBuf = Uint8Array.from(atob(apiSecret), c => c.charCodeAt(0));
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(nonce + body)));
  const pathBuf = enc.encode(path);
  const combined = new Uint8Array(pathBuf.length + hash.length);
  combined.set(pathBuf); combined.set(hash, pathBuf.length);
  const k = await crypto.subtle.importKey("raw", secretBuf, { name: "HMAC", hash: "SHA-512" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", k, combined);
  const sigB64 = btoa(String.fromCharCode(...new Uint8Array(sig)));
  const res = await fetch(`https://api.kraken.com${path}`, {
    method: "POST",
    headers: { "API-Key": apiKey, "API-Sign": sigB64, "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) {
    console.error(`Kraken API error [${path}]: ${res.status} ${await res.text()}`);
    return null;
  }
  const j = await res.json();
  if (j?.error?.length) {
    console.error(`Kraken API returned error [${path}]: ${JSON.stringify(j.error)}`);
    return null;
  }
  return j?.result || null;
}

serve((req) => handleSyncRequest(req, async (conn, supabase) => {
  const apiKey = conn.api_key_encrypted as string;
  const apiSecret = conn.api_secret_encrypted as string;
  const trades: NormalizedTrade[] = [];
  const start = Math.floor((Date.now() - 90 * 24 * 3600 * 1000) / 1000).toString();

  // Kraken TradesHistory returns max 50 per page - paginate via ofs
  let ofs = 0;
  let total = Infinity;
  let pages = 0;
  while (ofs < total && pages < 10) {
    const result = await krakenFetch("/0/private/TradesHistory", { start, ofs: ofs.toString() }, apiKey, apiSecret);
    if (!result?.trades) break;
    total = result.count ?? Object.keys(result.trades).length;

    for (const [tradeId, t] of Object.entries(result.trades) as [string, Record<string, unknown>][]) {
      const ts = parseFloat(t.time as string) * 1000;
      const pnl = parseFloat(t.net as string || "0");
      trades.push({
        external_trade_id: `kraken-${tradeId}`,
        // NOTE: verify pair formatting when live - Kraken's asset codes (XBT/X../Z..) are inconsistent,
        // this handles the common fiat pairs but crypto-to-crypto pairs may not format cleanly.
        symbol: (t.pair as string || "").replace("XBT", "BTC").replace("XXBT", "BTC")
          .replace(/^X(.+)Z(.+)$/, "$1/$2").replace("ZUSD", "/USD").replace("ZUSDT", "/USDT") || t.pair as string,
        direction: t.type === "buy" ? "long" : "short",
        lot_size: parseFloat(t.vol as string),
        lot_unit: "qty",
        entry_price: parseFloat(t.price as string),
        exit_price: null,
        entry_time: msToTime(ts),
        fees: parseFloat(t.fee as string),
        stop_loss: null,
        take_profit: null,
        conclusion: pnlToConclusion(pnl !== 0 ? pnl : null),
        date: msToDate(ts),
      });
    }
    ofs += 50;
    pages++;
  }

  return await saveSyncedTrades(supabase as never, conn.user_id as string, conn.id as string, trades);
}));
