// Thin REST client for YouTube Data API v3 + YouTube Analytics API v2, with quota tracking.
import fs from "node:fs";
import path from "node:path";
import { getAccessToken } from "./auth.js";

const DATA = "https://www.googleapis.com/youtube/v3";
const UPLOAD = "https://www.googleapis.com/upload/youtube/v3";
const ANALYTICS = "https://youtubeanalytics.googleapis.com/v2";

// Approximate Data API quota costs (units). Daily default quota: 10,000.
const COST = { list: 1, insert: 50, update: 50, delete: 50, "videos.insert": 100, "thumbnails.set": 50, "captions.insert": 400, "captions.update": 450, "captions.download": 200, "search.list": 100 };
const quota = { day: new Date().toISOString().slice(0, 10), used: 0, calls: {} };
function track(key, units) {
  const today = new Date().toISOString().slice(0, 10);
  if (today !== quota.day) Object.assign(quota, { day: today, used: 0, calls: {} });
  quota.used += units;
  quota.calls[key] = (quota.calls[key] || 0) + 1;
}
export const quotaUsage = () => ({ ...quota, daily_limit_default: 10000, note: "Estimate for this server session only (Pacific-time reset). Exact usage: Google Cloud Console → APIs → YouTube Data API v3 → Quotas." });

export class ApiError extends Error {
  constructor(status, body) {
    const e = body?.error;
    const reason = e?.errors?.[0]?.reason || e?.status || "";
    super(`YouTube API ${status}${reason ? ` (${reason})` : ""}: ${e?.message || JSON.stringify(body)}${hint(reason, status)}`);
    this.status = status; this.reason = reason;
  }
}
function hint(reason, status) {
  if (reason === "quotaExceeded") return "\nHint: daily quota exhausted; resets at midnight Pacific time. Request more in Google Cloud Console.";
  if (reason === "forbidden" || status === 403) return "\nHint: check that the signed-in account owns this resource and that the required API is enabled in your Cloud project.";
  if (reason === "insufficientPermissions" || reason === "ACCESS_TOKEN_SCOPE_INSUFFICIENT") return "\nHint: missing OAuth scope — run yt_auth_login again (with monetary:true for revenue metrics).";
  if (reason === "uploadLimitExceeded") return "\nHint: channel upload limit reached for today.";
  return "";
}

async function request(method, url, { query, body, headers = {}, raw = false, cost = 1, key = "call" } = {}, retried = false) {
  const u = new URL(url);
  if (query) for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== null && v !== "") u.searchParams.set(k, String(v));
  const token = await getAccessToken({ forceRefresh: retried });
  const init = { method, headers: { Authorization: `Bearer ${token}`, ...headers } };
  if (body !== undefined) {
    if (raw) init.body = body;
    else { init.body = JSON.stringify(body); init.headers["Content-Type"] = "application/json"; }
  }
  const res = await fetch(u, init);
  if (res.status === 401 && !retried) return request(method, url, { query, body, headers, raw, cost, key }, true);
  track(key, cost);
  if (res.status === 204) return {};
  const text = await res.text();
  let j; try { j = text ? JSON.parse(text) : {}; } catch { j = { raw: text }; }
  if (!res.ok) throw new ApiError(res.status, j);
  return Object.assign(j, { __headers: res.headers });
}

const strip = (o) => { if (o && typeof o === "object") delete o.__headers; return o; };
export const get = (resource, query, cost = 1) => request("GET", `${DATA}/${resource}`, { query, cost, key: `${resource}.list` }).then(strip);
export const post = (resource, query, body, cost = COST.insert) => request("POST", `${DATA}/${resource}`, { query, body, cost, key: `${resource}.insert` }).then(strip);
export const put = (resource, query, body, cost = COST.update) => request("PUT", `${DATA}/${resource}`, { query, body, cost, key: `${resource}.update` }).then(strip);
export const del = (resource, query, cost = COST.delete) => request("DELETE", `${DATA}/${resource}`, { query, cost, key: `${resource}.delete` }).then(strip);
/** Download a caption track as text (srt, vtt, sbv, scc, ttml). Costs 200 quota units. */
export async function downloadCaption(id, tfmt = "srt", tlang) {
  const r = await request("GET", `${DATA}/captions/${encodeURIComponent(id)}`, { query: { tfmt, tlang }, cost: COST["captions.download"], key: "captions.download" });
  return r.raw ?? "";
}
export const analytics = (query) => request("GET", `${ANALYTICS}/reports`, { query, cost: 0, key: "analytics.reports" }).then(strip);

/** Fetch every page of a list endpoint up to `max` items. */
export async function listAll(resource, query, max = 50) {
  const items = []; let pageToken;
  do {
    const r = await get(resource, { ...query, maxResults: Math.min(50, max - items.length), pageToken });
    items.push(...(r.items || []));
    pageToken = r.nextPageToken;
  } while (pageToken && items.length < max);
  return items;
}

const MIME = { ".mp4": "video/mp4", ".mov": "video/quicktime", ".m4v": "video/x-m4v", ".webm": "video/webm", ".avi": "video/x-msvideo", ".mkv": "video/x-matroska", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".srt": "application/octet-stream", ".vtt": "text/vtt", ".sbv": "text/plain" };
const mimeOf = (f) => MIME[path.extname(f).toLowerCase()] || "application/octet-stream";

function checkFile(file) {
  const abs = path.resolve(file.replace(/^~(?=$|\/)/, process.env.HOME || ""));
  const st = fs.statSync(abs, { throwIfNoEntry: false });
  if (!st?.isFile()) throw new Error(`File not found: ${abs}`);
  return { abs, size: st.size };
}

/** Resumable upload (videos, captions). Streams the file in 8 MB chunks with retry. */
export async function resumableUpload(resource, query, metadata, file, cost) {
  const { abs, size } = checkFile(file);
  const type = mimeOf(abs);
  const init = await request("POST", `${UPLOAD}/${resource}`, {
    query: { ...query, uploadType: "resumable" },
    body: metadata,
    headers: { "X-Upload-Content-Length": String(size), "X-Upload-Content-Type": type },
    cost, key: `${resource}.insert`,
  });
  const location = init.__headers.get("location");
  if (!location) throw new Error("Upload session was not created (no Location header).");

  const CHUNK = 8 * 1024 * 1024;
  const fd = fs.openSync(abs, "r");
  try {
    let offset = 0, attempts = 0;
    while (true) {
      const len = Math.min(CHUNK, size - offset);
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, offset);
      const token = await getAccessToken();
      let res;
      try {
        res = await fetch(location, {
          method: "PUT",
          headers: { Authorization: `Bearer ${token}`, "Content-Type": type, "Content-Length": String(len), "Content-Range": `bytes ${offset}-${offset + len - 1}/${size}` },
          body: buf,
        });
      } catch (e) {
        if (++attempts > 5) throw e;
        await new Promise((r) => setTimeout(r, 2 ** attempts * 1000));
        offset = await queryOffset(location, size, type) ?? offset;
        continue;
      }
      if (res.status === 308) {
        const range = res.headers.get("range");
        offset = range ? Number(range.split("-")[1]) + 1 : 0;
        attempts = 0; continue;
      }
      if (res.ok) return res.json();
      if ([500, 502, 503, 504].includes(res.status) && ++attempts <= 5) {
        await new Promise((r) => setTimeout(r, 2 ** attempts * 1000));
        offset = await queryOffset(location, size, type) ?? offset;
        continue;
      }
      throw new ApiError(res.status, await res.json().catch(() => ({})));
    }
  } finally { fs.closeSync(fd); }
}
async function queryOffset(location, size, type) {
  const token = await getAccessToken();
  const r = await fetch(location, { method: "PUT", headers: { Authorization: `Bearer ${token}`, "Content-Range": `bytes */${size}`, "Content-Type": type } }).catch(() => null);
  if (r?.status === 308) { const range = r.headers.get("range"); return range ? Number(range.split("-")[1]) + 1 : 0; }
  return null;
}

/** Simple media upload (thumbnails ≤ 2 MB). */
export async function mediaUpload(resource, query, file, cost) {
  const { abs, size } = checkFile(file);
  if (resource === "thumbnails/set" && size > 2 * 1024 * 1024) throw new Error("Thumbnail must be ≤ 2 MB (JPEG/PNG, 1280×720 recommended).");
  return request("POST", `${UPLOAD}/${resource}`, { query: { ...query, uploadType: "media" }, body: fs.readFileSync(abs), raw: true, headers: { "Content-Type": mimeOf(abs) }, cost, key: resource }).then(strip);
}

export { COST };
