// Google OAuth 2.0 for installed apps: loopback redirect + PKCE, local token store, auto-refresh.
import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const REVOKE_URL = "https://oauth2.googleapis.com/revoke";

export const BASE_SCOPES = [
  "https://www.googleapis.com/auth/youtube",            // manage videos, playlists, comments
  "https://www.googleapis.com/auth/youtube.upload",
  "https://www.googleapis.com/auth/youtube.force-ssl",  // captions, comment moderation
  "https://www.googleapis.com/auth/yt-analytics.readonly",
];
export const MONETARY_SCOPE = "https://www.googleapis.com/auth/yt-analytics-monetary.readonly";

const profile = (process.env.YT_PROFILE || "default").replace(/[^a-zA-Z0-9_-]/g, "");
export const CONFIG_DIR = process.env.YT_CONFIG_DIR || path.join(os.homedir(), ".config", "claude-youtube");
const TOKEN_FILE = path.join(CONFIG_DIR, `tokens-${profile}.json`);
const CLIENT_FILE = path.join(CONFIG_DIR, "client_secret.json");

export class AuthError extends Error {}

export function setupInstructions() {
  return [
    "YouTube OAuth client is not configured. One-time setup (~3 minutes):",
    "1. Open https://console.cloud.google.com/ and create (or pick) a project.",
    "2. APIs & Services → Library → enable 'YouTube Data API v3' and 'YouTube Analytics API'.",
    "3. APIs & Services → OAuth consent screen → External → add your Google account as a test user",
    "   (then click 'Publish app' so refresh tokens don't expire after 7 days).",
    "4. APIs & Services → Credentials → Create credentials → OAuth client ID → Application type: 'Desktop app'.",
    `5. Download the JSON and save it as: ${CLIENT_FILE}`,
    "   (or set env vars YT_CLIENT_ID and YT_CLIENT_SECRET).",
    "Then run yt_auth_login again.",
  ].join("\n");
}

export function loadClient() {
  if (process.env.YT_CLIENT_ID && process.env.YT_CLIENT_SECRET) {
    return { client_id: process.env.YT_CLIENT_ID, client_secret: process.env.YT_CLIENT_SECRET };
  }
  if (fs.existsSync(CLIENT_FILE)) {
    const j = JSON.parse(fs.readFileSync(CLIENT_FILE, "utf8"));
    const c = j.installed || j.web || j;
    if (c.client_id && c.client_secret) return { client_id: c.client_id, client_secret: c.client_secret };
  }
  throw new AuthError(setupInstructions());
}

function readTokens() {
  try { return JSON.parse(fs.readFileSync(TOKEN_FILE, "utf8")); } catch { return null; }
}
function writeTokens(t) {
  fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  fs.writeFileSync(TOKEN_FILE, JSON.stringify(t, null, 2), { mode: 0o600 });
  fs.chmodSync(TOKEN_FILE, 0o600);
}
function clearTokens() { try { fs.unlinkSync(TOKEN_FILE); } catch {} }

const b64url = (buf) => buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

function openBrowser(url) {
  if (process.env.YT_NO_BROWSER) return false;
  const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  try { spawn(cmd, args, { stdio: "ignore", detached: true }).unref(); return true; } catch { return false; }
}

async function postToken(params) {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new AuthError(`Token endpoint error: ${j.error || res.status} ${j.error_description || ""}`.trim());
    err.code = j.error;
    throw err;
  }
  return j;
}

const page = (title, msg) =>
  `<!doctype html><meta charset="utf-8"><title>${title}</title><body style="font-family:system-ui;max-width:520px;margin:80px auto;text-align:center"><h2>${title}</h2><p>${msg}</p></body>`;

/**
 * Starts loopback server, opens browser, resolves once the user consents.
 * onUrl(url) is called immediately so the caller can surface the link.
 */
export async function login({ monetary = false, timeoutMs = 300_000, onUrl } = {}) {
  const client = loadClient();
  const verifier = b64url(crypto.randomBytes(48));
  const challenge = b64url(crypto.createHash("sha256").update(verifier).digest());
  const state = b64url(crypto.randomBytes(16));
  const scopes = monetary ? [...BASE_SCOPES, MONETARY_SCOPE] : BASE_SCOPES;

  const server = http.createServer();
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const redirectUri = `http://127.0.0.1:${server.address().port}/callback`;

  const url = `${AUTH_URL}?${new URLSearchParams({
    client_id: client.client_id,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: scopes.join(" "),
    access_type: "offline",
    prompt: "consent select_account",
    include_granted_scopes: "true",
    code_challenge: challenge,
    code_challenge_method: "S256",
    state,
  })}`;

  const opened = openBrowser(url);
  onUrl?.(url, opened);

  try {
    const code = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new AuthError("Login timed out after 5 minutes. Run yt_auth_login again.")), timeoutMs);
      server.on("request", (req, res) => {
        const u = new URL(req.url, redirectUri);
        if (u.pathname !== "/callback") { res.writeHead(404).end(); return; }
        const err = u.searchParams.get("error");
        if (err) {
          res.writeHead(400, { "Content-Type": "text/html" }).end(page("Sign-in cancelled", `Google returned: ${err}. You can close this tab.`));
          clearTimeout(timer); reject(new AuthError(`Google sign-in failed: ${err}`)); return;
        }
        if (u.searchParams.get("state") !== state) {
          res.writeHead(400, { "Content-Type": "text/html" }).end(page("Invalid state", "Please retry sign-in."));
          return;
        }
        res.writeHead(200, { "Content-Type": "text/html" }).end(page("YouTube connected ✅", "You can close this tab and return to Claude."));
        clearTimeout(timer); resolve(u.searchParams.get("code"));
      });
    });

    const tok = await postToken({
      code, client_id: client.client_id, client_secret: client.client_secret,
      redirect_uri: redirectUri, grant_type: "authorization_code", code_verifier: verifier,
    });
    if (!tok.refresh_token) throw new AuthError("Google did not return a refresh token. Revoke access at https://myaccount.google.com/permissions and retry.");
    const stored = {
      access_token: tok.access_token,
      refresh_token: tok.refresh_token,
      scope: tok.scope,
      expires_at: Date.now() + (tok.expires_in - 60) * 1000,
      created_at: new Date().toISOString(),
    };
    writeTokens(stored);
    return { scopes: tok.scope.split(" ") };
  } finally {
    server.close();
  }
}

export async function getAccessToken({ forceRefresh = false } = {}) {
  const t = readTokens();
  if (!t) throw new AuthError("Not signed in to YouTube. Run the yt_auth_login tool (or /yt-login) first.");
  if (!forceRefresh && t.access_token && Date.now() < t.expires_at) return t.access_token;
  const client = loadClient();
  try {
    const r = await postToken({
      client_id: client.client_id, client_secret: client.client_secret,
      refresh_token: t.refresh_token, grant_type: "refresh_token",
    });
    t.access_token = r.access_token;
    t.expires_at = Date.now() + (r.expires_in - 60) * 1000;
    if (r.scope) t.scope = r.scope;
    writeTokens(t);
    return t.access_token;
  } catch (e) {
    if (e.code === "invalid_grant") {
      clearTokens();
      throw new AuthError("YouTube authorization expired or was revoked. Run yt_auth_login again. (If this happens every 7 days, publish your OAuth consent screen — see SETUP.md.)");
    }
    throw e;
  }
}

export function status() {
  const t = readTokens();
  let clientConfigured = true;
  try { loadClient(); } catch { clientConfigured = false; }
  return {
    profile,
    client_configured: clientConfigured,
    signed_in: !!t,
    scopes: t?.scope?.split(" ") || [],
    monetary_enabled: !!t?.scope?.includes("monetary"),
    signed_in_at: t?.created_at || null,
    token_file: TOKEN_FILE,
  };
}

export async function logout() {
  const t = readTokens();
  if (t?.refresh_token) {
    await fetch(`${REVOKE_URL}?token=${encodeURIComponent(t.refresh_token)}`, { method: "POST" }).catch(() => {});
  }
  clearTokens();
}
