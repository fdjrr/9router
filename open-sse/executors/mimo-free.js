import { BaseExecutor } from "./base.js";
import { PROVIDERS } from "../config/providers.js";
import { proxyAwareFetch } from "../utils/proxyFetch.js";
import { createHash } from "crypto";

const BOOTSTRAP_URL = "https://api.xiaomimimo.com/api/free-ai/bootstrap";
const CHAT_URL = "https://api.xiaomimimo.com/api/free-ai/openai/chat";
const SESSION_AFFINITY_PREFIX = "ses_";

// In-memory JWT cache (per-process, survives across requests but not restarts)
let cachedJwt = null;
let jwtExpiresAt = 0;

function generateClientHash() {
  return createHash("sha256").update(`mimocode-free-${Date.now()}`).digest("hex");
}

function generateSessionId() {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  let id = SESSION_AFFINITY_PREFIX;
  for (let i = 0; i < 24; i++) {
    id += chars[Math.floor(Math.random() * chars.length)];
  }
  return id;
}

async function bootstrapJwt(proxyOptions = null) {
  // Return cached JWT if still valid (with 5-minute buffer)
  if (cachedJwt && Date.now() < jwtExpiresAt - 300000) {
    return cachedJwt;
  }

  const clientHash = generateClientHash();
  const response = await proxyAwareFetch(BOOTSTRAP_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "User-Agent": "mimocode/0.1.0",
      "Accept": "*/*",
    },
    body: JSON.stringify({ client: clientHash }),
  }, proxyOptions);

  if (!response.ok) {
    throw new Error(`MiMo bootstrap failed: ${response.status}`);
  }

  const data = await response.json();
  if (!data.jwt) {
    throw new Error("MiMo bootstrap returned no JWT");
  }

  cachedJwt = data.jwt;
  // JWT expires in ~1 hour based on HAR analysis; cache for 50 minutes
  jwtExpiresAt = Date.now() + (data.expiresIn || 3600) * 1000;

  return cachedJwt;
}

export class MimoFreeExecutor extends BaseExecutor {
  constructor() {
    super("mimo-free", PROVIDERS["mimo-free"]);
    this.sessionId = generateSessionId();
  }

  buildUrl(model, stream, urlIndex = 0, credentials = null) {
    return CHAT_URL;
  }

  buildHeaders(credentials, stream = true) {
    return {
      "Content-Type": "application/json",
      "X-Mimo-Source": "mimocode-cli-free",
      "x-session-affinity": this.sessionId,
      "Accept": stream ? "text/event-stream" : "application/json",
    };
  }

  async execute({ model, body, stream, credentials, signal, log, proxyOptions = null }) {
    // Get JWT via bootstrap
    let jwt;
    try {
      jwt = await bootstrapJwt(proxyOptions);
    } catch (error) {
      log?.error?.("AUTH", `MiMo bootstrap failed: ${error.message}`);
      throw error;
    }

    const url = this.buildUrl(model, stream);
    const transformedBody = this.transformRequest(model, body);
    const headers = {
      ...this.buildHeaders(credentials, stream),
      "Authorization": `Bearer ${jwt}`,
    };

    const bodyStr = JSON.stringify(transformedBody);
    log?.debug?.("FETCH", `MIMO-FREE → ${url} | body=${bodyStr.length}B`);

    const response = await proxyAwareFetch(url, {
      method: "POST",
      headers,
      body: bodyStr,
      signal,
    }, proxyOptions);

    // If 401, invalidate cache and retry once
    if (response.status === 401) {
      log?.debug?.("AUTH", "MiMo JWT expired, re-bootstrapping...");
      cachedJwt = null;
      jwtExpiresAt = 0;
      try {
        jwt = await bootstrapJwt(proxyOptions);
      } catch (error) {
        throw error;
      }
      headers["Authorization"] = `Bearer ${jwt}`;
      const retryResponse = await proxyAwareFetch(url, {
        method: "POST",
        headers,
        body: bodyStr,
        signal,
      }, proxyOptions);
      return { response: retryResponse, url, headers, transformedBody };
    }

    return { response, url, headers, transformedBody };
  }

  transformRequest(model, body) {
    return body;
  }
}

export default MimoFreeExecutor;
