// supabase/functions/broker-connect/index.ts

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// ═══════════════════════════════════════════
// CORS Headers
// ═══════════════════════════════════════════
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// ═══════════════════════════════════════════
// Simple Encryption (AES-GCM via Web Crypto)
// ═══════════════════════════════════════════
async function encryptData(plaintext: string, secret: string): Promise<string> {
  const encoder = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret.padEnd(32, "0").slice(0, 32)),
    { name: "AES-GCM" },
    false,
    ["encrypt"]
  );
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    keyMaterial,
    encoder.encode(plaintext)
  );
  const combined = new Uint8Array(iv.length + encrypted.byteLength);
  combined.set(iv);
  combined.set(new Uint8Array(encrypted), iv.length);
  return btoa(String.fromCharCode(...combined));
}

// ═══════════════════════════════════════════
// Broker Validation Functions
// ═══════════════════════════════════════════
async function validateBinance(apiKey: string, apiSecret: string): Promise<boolean> {
  try {
    const timestamp = Date.now();
    const queryString = `timestamp=${timestamp}`;
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(apiSecret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"]
    );
    const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(queryString));
    const signature = Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, "0")).join("");

    const res = await fetch(
      `https://api.binance.com/api/v3/account?${queryString}&signature=${signature}`,
      { headers: { "X-MBX-APIKEY": apiKey } }
    );
    return res.ok;
  } catch {
    return false;
  }
}

async function validateBybit(apiKey: string, apiSecret: string): Promise<boolean> {
  try {
    const timestamp = Date.now().toString();
    const recvWindow = "5000";
    const paramStr = timestamp + apiKey + recvWindow;
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(apiSecret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"]
    );
    const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(paramStr));
    const signature = Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, "0")).join("");

    const res = await fetch("https://api.bybit.com/v5/account/wallet-balance?accountType=UNIFIED", {
      headers: {
        "X-BAPI-API-KEY": apiKey,
        "X-BAPI-TIMESTAMP": timestamp,
        "X-BAPI-RECV-WINDOW": recvWindow,
        "X-BAPI-SIGN": signature,
      },
    });
    const data = await res.json();
    return data.retCode === 0;
  } catch {
    return false;
  }
}

async function validateOKX(apiKey: string, apiSecret: string, passphrase: string): Promise<boolean> {
  try {
    const timestamp = new Date().toISOString();
    const method = "GET";
    const path = "/api/v5/account/balance";
    const prehash = timestamp + method + path;
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(apiSecret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"]
    );
    const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(prehash));
    const signature = btoa(String.fromCharCode(...new Uint8Array(sig)));

    const res = await fetch(`https://www.okx.com${path}`, {
      headers: {
        "OK-ACCESS-KEY": apiKey,
        "OK-ACCESS-SIGN": signature,
        "OK-ACCESS-TIMESTAMP": timestamp,
        "OK-ACCESS-PASSPHRASE": passphrase,
        "x-simulated-trading": "0",
      },
    });
    const data = await res.json();
    return data.code === "0";
  } catch {
    return false;
  }
}

async function validateDelta(apiKey: string, apiSecret: string): Promise<boolean> {
  try {
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const method = "GET";
    const path = "/v2/profile";
    const prehash = method + timestamp + path;
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(apiSecret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"]
    );
    const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(prehash));
    const signature = Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, "0")).join("");

    const res = await fetch(`https://api.delta.exchange${path}`, {
      headers: {
        "api-key": apiKey,
        "timestamp": timestamp,
        "signature": signature,
      },
    });
    return res.ok;
  } catch {
    return false;
  }
}

async function validateZerodha(apiKey: string, accessToken: string): Promise<boolean> {
  try {
    const res = await fetch("https://api.kite.trade/user/profile", {
      headers: {
        "X-Kite-Version": "3",
        "Authorization": `token ${apiKey}:${accessToken}`,
      },
    });
    const data = await res.json();
    return data.status === "success";
  } catch {
    return false;
  }
}

// ═══════════════════════════════════════════
// MAIN HANDLER
// ═══════════════════════════════════════════
serve(async (req) => {
  // OPTIONS preflight
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    // ── Auth check ──
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return new Response(
        JSON.stringify({ success: false, error: "Unauthorized" }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // ── Supabase client (user context) ──
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!,
      { global: { headers: { Authorization: authHeader } } }
    );

    // ── Get user ──
    const { data: { user }, error: userError } = await supabase.auth.getUser();
    if (userError || !user) {
      return new Response(
        JSON.stringify({ success: false, error: "Invalid token" }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // ── Parse body ──
    const body = await req.json();
    const { broker_id, account_label, api_key, api_secret, api_passphrase, access_token } = body;

    if (!broker_id || !api_key) {
      return new Response(
        JSON.stringify({ success: false, error: "broker_id aur api_key required hai" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // ── Validate with broker ──
    let isValid = false;
    const brokerLower = broker_id.toLowerCase();

    if (brokerLower === "binance") {
      if (!api_secret) return errorResponse("Binance ke liye api_secret chahiye");
      isValid = await validateBinance(api_key, api_secret);

    } else if (brokerLower === "bybit") {
      if (!api_secret) return errorResponse("Bybit ke liye api_secret chahiye");
      isValid = await validateBybit(api_key, api_secret);

    } else if (brokerLower === "okx") {
      if (!api_secret || !api_passphrase) return errorResponse("OKX ke liye api_secret aur api_passphrase chahiye");
      isValid = await validateOKX(api_key, api_secret, api_passphrase);

    } else if (brokerLower === "delta") {
      if (!api_secret) return errorResponse("Delta ke liye api_secret chahiye");
      isValid = await validateDelta(api_key, api_secret);

    } else if (brokerLower === "zerodha") {
      if (!access_token) return errorResponse("Zerodha ke liye access_token chahiye");
      isValid = await validateZerodha(api_key, access_token);

    } else {
      return errorResponse("Invalid broker_id. Supported: binance, bybit, okx, delta, zerodha");
    }

    if (!isValid) {
      return new Response(
        JSON.stringify({ success: false, error: "API key invalid hai ya broker se connect nahi ho paya" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // ── Encryption secret ──
    const encSecret = Deno.env.get("ENCRYPTION_SECRET") ?? "edgetrade-default-secret-key-2024";

    // ── Encrypt keys ──
    const encryptedKey = await encryptData(api_key, encSecret);
    const encryptedSecret = api_secret ? await encryptData(api_secret, encSecret) : null;
    const encryptedPassphrase = api_passphrase ? await encryptData(api_passphrase, encSecret) : null;
    const extraData = access_token ? { access_token: await encryptData(access_token, encSecret) } : null;

    // ── Upsert in DB ──
    const { error: dbError } = await supabase
      .from("user_broker_connections")
      .upsert({
        user_id: user.id,
        broker_id: brokerLower,
        account_label: account_label ?? brokerLower,
        api_key_encrypted: encryptedKey,
        api_secret_encrypted: encryptedSecret,
        api_passphrase_encrypted: encryptedPassphrase,
        extra_data: extraData,
        is_active: true,
        sync_status: "connected",
        last_sync: new Date().toISOString(),
      }, {
        onConflict: "user_id,broker_id",
      });

    if (dbError) {
      console.error("DB Error:", dbError);
      return new Response(
        JSON.stringify({ success: false, error: "Database mein save nahi hua" }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // ── Success ──
    return new Response(
      JSON.stringify({
        success: true,
        message: `${broker_id} successfully connect ho gaya!`,
        broker_id: brokerLower,
      }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );

  } catch (err) {
    console.error("Unexpected error:", err);
    return new Response(
      JSON.stringify({ success: false, error: "Server error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});

// Helper
function errorResponse(msg: string) {
  return new Response(
    JSON.stringify({ success: false, error: msg }),
    { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
  );
}