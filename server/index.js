#!/usr/bin/env node
// YouTube MCP server for Claude.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import * as auth from "./auth.js";
import * as yt from "./youtube.js";

const server = new McpServer({ name: "youtube", version: "1.0.0" });

const ok = (data) => ({ content: [{ type: "text", text: typeof data === "string" ? data : JSON.stringify(data, null, 2) }] });
const fail = (e) => ({ isError: true, content: [{ type: "text", text: e?.message || String(e) }] });
function tool(name, description, shape, handler, annotations = {}) {
  server.registerTool(name, { description, inputSchema: shape, annotations }, async (args) => {
    try { return ok(await handler(args || {})); } catch (e) { return fail(e); }
  });
}
const RO = { readOnlyHint: true };
const DESTRUCTIVE = { destructiveHint: true };

// ---------- helpers ----------
const day = (offset = 0) => new Date(Date.now() + offset * 864e5).toISOString().slice(0, 10);
const range = (a) => ({ startDate: a.start_date || day(-30), endDate: a.end_date || day(-2) });
const dateArgs = {
  start_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("YYYY-MM-DD (default: 30 days ago)"),
  end_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("YYYY-MM-DD (default: 2 days ago; analytics lag 24–72h)"),
};
function rows(report) {
  const cols = (report.columnHeaders || []).map((c) => c.name);
  return { columns: cols, rows: (report.rows || []).map((r) => Object.fromEntries(r.map((v, i) => [cols[i], v]))) };
}
async function runReport(a, extra) {
  const r = await yt.analytics({ ids: "channel==MINE", ...range(a), ...extra });
  return { period: range(a), ...rows(r) };
}
async function uploadsPlaylistId() {
  const r = await yt.get("channels", { part: "contentDetails", mine: true });
  const id = r.items?.[0]?.contentDetails?.relatedPlaylists?.uploads;
  if (!id) throw new Error("No YouTube channel found for the signed-in account. Create a channel or sign in with a Brand Account.");
  return id;
}
function slimVideo(v) {
  return {
    id: v.id, url: `https://youtu.be/${v.id}`,
    title: v.snippet?.title, description: v.snippet?.description, tags: v.snippet?.tags,
    categoryId: v.snippet?.categoryId, publishedAt: v.snippet?.publishedAt,
    thumbnail: v.snippet?.thumbnails?.maxres?.url || v.snippet?.thumbnails?.high?.url,
    duration: v.contentDetails?.duration,
    privacyStatus: v.status?.privacyStatus, publishAt: v.status?.publishAt, uploadStatus: v.status?.uploadStatus,
    madeForKids: v.status?.madeForKids, license: v.status?.license,
    views: num(v.statistics?.viewCount), likes: num(v.statistics?.likeCount), comments: num(v.statistics?.commentCount),
    processing: v.processingDetails?.processingStatus,
  };
}
const num = (x) => (x === undefined ? undefined : Number(x));
const VIDEO_PARTS = "snippet,contentDetails,status,statistics";
async function getVideos(ids) {
  const out = [];
  for (let i = 0; i < ids.length; i += 50) {
    const r = await yt.get("videos", { part: VIDEO_PARTS, id: ids.slice(i, i + 50).join(",") });
    out.push(...(r.items || []));
  }
  return out;
}
function requireConfirm(a, what) {
  if (a.confirm !== true) throw new Error(`Refusing to ${what} without confirm:true. Ask the user to confirm first.`);
}

// ---------- auth ----------
let pendingLogin = null;
tool("yt_auth_login",
  "Connect a YouTube channel via browser sign-in (Google OAuth). Opens the browser and returns the sign-in URL. Waits up to `wait_seconds` for completion; if still pending, call yt_auth_status after the user finishes.",
  { monetary: z.boolean().optional().describe("Also request revenue/ad metrics scope (YPP channels only)"),
    wait_seconds: z.number().int().min(0).max(240).optional().describe("How long to wait for sign-in (default 90)") },
  async (a) => {
    if (!pendingLogin) {
      let gotUrl; const urlReady = new Promise((r) => (gotUrl = r));
      const p = auth.login({ monetary: !!a.monetary, onUrl: (u, o) => gotUrl({ u, o }) });
      const pl = { promise: p, url: null, result: null, error: null };
      pendingLogin = pl;
      p.then((r) => (pl.result = r), (e) => (pl.error = e))
        .finally(() => setTimeout(() => { if (pendingLogin === pl) pendingLogin = null; }, 1000));
      const first = await Promise.race([urlReady, p.then(() => null, () => null)]);
      if (first) { pl.url = first.u; pl.opened = first.o; }
    }
    const pl = pendingLogin;
    const wait = (a.wait_seconds ?? 90) * 1000;
    await Promise.race([pl.promise.catch(() => {}), new Promise((r) => setTimeout(r, wait))]);
    if (pl.error) throw pl.error;
    if (pl.result) {
      const ch = await yt.get("channels", { part: "snippet,statistics", mine: true }).catch(() => null);
      const c = ch?.items?.[0];
      return { status: "connected", channel: c ? { id: c.id, title: c.snippet.title, subscribers: num(c.statistics.subscriberCount) } : "no channel on this account", scopes: pl.result.scopes };
    }
    return { status: "waiting_for_user", browser_opened: !!pl.opened, sign_in_url: pl.url,
      next: "Open the URL (if the browser didn't open), sign in, choose the channel, and allow access. Then call yt_auth_status." };
  });

tool("yt_auth_status", "Show whether YouTube is connected, which scopes are granted, and the connected channel.", {}, async () => {
  const s = auth.status();
  if (pendingLogin && !pendingLogin.result && !pendingLogin.error) s.login_in_progress = { sign_in_url: pendingLogin.url };
  if (!s.client_configured) s.setup = auth.setupInstructions();
  if (s.signed_in) {
    const r = await yt.get("channels", { part: "snippet", mine: true }).catch((e) => ({ error: e.message }));
    s.channel = r.error ? r.error : r.items?.[0] ? { id: r.items[0].id, title: r.items[0].snippet.title } : "no channel";
  }
  return s;
}, RO);

tool("yt_auth_logout", "Disconnect YouTube: revoke the token with Google and delete it locally.", {}, async () => {
  await auth.logout(); return "Signed out and token revoked.";
});

// ---------- channel ----------
tool("yt_channel_info", "Get the connected channel's details and lifetime statistics.", {}, async () => {
  const r = await yt.get("channels", { part: "snippet,statistics,brandingSettings,contentDetails,status", mine: true });
  const c = r.items?.[0];
  if (!c) throw new Error("No channel on this account.");
  return {
    id: c.id, title: c.snippet.title, handle: c.snippet.customUrl, description: c.snippet.description,
    country: c.snippet.country, created: c.snippet.publishedAt, url: `https://youtube.com/channel/${c.id}`,
    subscribers: num(c.statistics.subscriberCount), views: num(c.statistics.viewCount), videos: num(c.statistics.videoCount),
    hiddenSubscriberCount: c.statistics.hiddenSubscriberCount,
    uploadsPlaylist: c.contentDetails.relatedPlaylists.uploads,
    keywords: c.brandingSettings?.channel?.keywords, longUploadsStatus: c.status?.longUploadsStatus,
  };
}, RO);

// ---------- videos ----------
tool("yt_list_videos",
  "List the channel's uploaded videos (newest first) incl. private/scheduled ones, with stats. Cheap on quota.",
  { max: z.number().int().min(1).max(500).optional().describe("Max videos (default 25)"),
    status: z.enum(["any", "public", "private", "unlisted", "scheduled"]).optional() },
  async (a) => {
    const items = await yt.listAll("playlistItems", { part: "contentDetails", playlistId: await uploadsPlaylistId() }, a.max || 25);
    let vids = (await getVideos(items.map((i) => i.contentDetails.videoId))).map(slimVideo);
    if (a.status && a.status !== "any") vids = vids.filter((v) => a.status === "scheduled" ? !!v.publishAt : v.privacyStatus === a.status && !(a.status === "private" && v.publishAt));
    return vids.map(({ description, ...v }) => v);
  }, RO);

tool("yt_get_video", "Full details for one or more videos (title, description, tags, status, schedule, stats, processing).",
  { video_ids: z.array(z.string()).min(1).max(50) },
  async (a) => (await getVideos(a.video_ids)).map(slimVideo), RO);

const metaShape = {
  title: z.string().max(100).optional(),
  description: z.string().max(5000).optional(),
  tags: z.array(z.string()).optional(),
  category_id: z.string().optional().describe("See yt_categories (e.g. 22 People & Blogs, 27 Education, 28 Science & Tech)"),
  privacy_status: z.enum(["public", "private", "unlisted"]).optional(),
  publish_at: z.string().optional().describe("ISO 8601 datetime to auto-publish (forces privacy 'private' until then), e.g. 2026-12-01T15:00:00Z"),
  made_for_kids: z.boolean().optional(),
  embeddable: z.boolean().optional(),
  license: z.enum(["youtube", "creativeCommon"]).optional(),
  default_language: z.string().optional(),
  contains_synthetic_media: z.boolean().optional().describe("Disclose realistic AI-altered/synthetic content"),
};
function validatePublishAt(s) {
  if (!s) return;
  const t = Date.parse(s);
  if (Number.isNaN(t)) throw new Error(`publish_at is not a valid ISO 8601 date: ${s}`);
  if (t < Date.now() + 60_000) throw new Error("publish_at must be in the future.");
  return new Date(t).toISOString();
}
function buildSnippetStatus(a, base = {}) {
  const snippet = { ...(base.snippet || {}) };
  const status = { ...(base.status || {}) };
  if (a.title !== undefined) snippet.title = a.title;
  if (a.description !== undefined) snippet.description = a.description;
  if (a.tags !== undefined) snippet.tags = a.tags;
  if (a.category_id !== undefined) snippet.categoryId = a.category_id;
  if (a.default_language !== undefined) snippet.defaultLanguage = a.default_language;
  if (a.privacy_status !== undefined) status.privacyStatus = a.privacy_status;
  if (a.made_for_kids !== undefined) status.selfDeclaredMadeForKids = a.made_for_kids;
  if (a.embeddable !== undefined) status.embeddable = a.embeddable;
  if (a.license !== undefined) status.license = a.license;
  if (a.contains_synthetic_media !== undefined) status.containsSyntheticMedia = a.contains_synthetic_media;
  const pa = validatePublishAt(a.publish_at);
  if (pa) { status.publishAt = pa; status.privacyStatus = "private"; }
  return { snippet, status };
}

tool("yt_update_video", "Edit a video's title, description, tags, category, privacy, schedule, kids/AI-disclosure flags. Only provided fields change.",
  { video_id: z.string(), ...metaShape },
  async (a) => {
    const [cur] = await getVideos([a.video_id]);
    if (!cur) throw new Error(`Video ${a.video_id} not found or not owned by you.`);
    const base = { snippet: { title: cur.snippet.title, description: cur.snippet.description, tags: cur.snippet.tags, categoryId: cur.snippet.categoryId, defaultLanguage: cur.snippet.defaultLanguage },
      status: { privacyStatus: cur.status.privacyStatus, embeddable: cur.status.embeddable, license: cur.status.license, publicStatsViewable: cur.status.publicStatsViewable, selfDeclaredMadeForKids: cur.status.madeForKids, ...(cur.status.publishAt ? { publishAt: cur.status.publishAt } : {}) } };
    const body = { id: a.video_id, ...buildSnippetStatus(a, base) };
    if (a.privacy_status && a.privacy_status !== "private" && !a.publish_at) delete body.status.publishAt;
    const r = await yt.put("videos", { part: "snippet,status" }, body);
    return slimVideo(r);
  });

tool("yt_upload_video",
  "Upload a local video file (any size, resumable). Set publish_at to schedule automatic publishing. Shorts = vertical video ≤ 3 min. Costs ~100 quota units.",
  { file_path: z.string().describe("Absolute path to the video file"), title: z.string().max(100), ...metaShape,
    thumbnail_path: z.string().optional().describe("Optional JPEG/PNG ≤ 2 MB"),
    playlist_id: z.string().optional().describe("Optional playlist to add it to"),
    notify_subscribers: z.boolean().optional() },
  async (a) => {
    const meta = buildSnippetStatus({ privacy_status: "private", category_id: "22", ...a });
    const v = await yt.resumableUpload("videos", { part: "snippet,status", notifySubscribers: a.notify_subscribers ?? true }, meta, a.file_path, yt.COST["videos.insert"]);
    const out = { uploaded: slimVideo(v), studio_url: `https://studio.youtube.com/video/${v.id}/edit` };
    const want = meta.status.privacyStatus;
    if (v.status?.privacyStatus !== want) out.warning = `Requested '${want}' but YouTube set '${v.status?.privacyStatus}'. Unverified API projects can only upload private videos — request an API audit (see SETUP.md).`;
    if (a.thumbnail_path) out.thumbnail = await yt.mediaUpload("thumbnails/set", { videoId: v.id }, a.thumbnail_path, 50).then(() => "set", (e) => `failed: ${e.message}`);
    if (a.playlist_id) out.playlist = await yt.post("playlistItems", { part: "snippet" }, { snippet: { playlistId: a.playlist_id, resourceId: { kind: "youtube#video", videoId: v.id } } }).then(() => "added", (e) => `failed: ${e.message}`);
    return out;
  });

tool("yt_schedule_video", "Schedule an existing (private) video to go public at a given time, or cancel a schedule (publish_at: null keeps it private).",
  { video_id: z.string(), publish_at: z.string().nullable().describe("ISO 8601 datetime, or null to cancel") },
  async (a) => {
    const [cur] = await getVideos([a.video_id]);
    if (!cur) throw new Error("Video not found.");
    const status = { privacyStatus: "private", embeddable: cur.status.embeddable, license: cur.status.license, selfDeclaredMadeForKids: cur.status.madeForKids };
    if (a.publish_at) status.publishAt = validatePublishAt(a.publish_at);
    else if (cur.status.privacyStatus === "public") throw new Error("Video is already public; set privacy with yt_update_video instead.");
    const r = await yt.put("videos", { part: "status" }, { id: a.video_id, status });
    return { id: r.id, privacyStatus: r.status.privacyStatus, publishAt: r.status.publishAt || null };
  });

tool("yt_set_thumbnail", "Set a custom thumbnail (JPEG/PNG ≤ 2 MB; channel must be verified for custom thumbnails).",
  { video_id: z.string(), file_path: z.string() },
  async (a) => { const r = await yt.mediaUpload("thumbnails/set", { videoId: a.video_id }, a.file_path, 50); return r.items?.[0] || r; });

tool("yt_delete_video", "PERMANENTLY delete a video. Irreversible — always ask the user and pass confirm:true.",
  { video_id: z.string(), confirm: z.boolean().optional() },
  async (a) => { requireConfirm(a, "delete a video"); await yt.del("videos", { id: a.video_id }); return `Deleted ${a.video_id}.`; }, DESTRUCTIVE);

tool("yt_categories", "List video category IDs for a region.", { region: z.string().length(2).optional() },
  async (a) => (await yt.get("videoCategories", { part: "snippet", regionCode: a.region || "US" })).items.filter((c) => c.snippet.assignable).map((c) => ({ id: c.id, title: c.snippet.title })), RO);

// ---------- playlists ----------
tool("yt_list_playlists", "List the channel's playlists.", { max: z.number().int().min(1).max(200).optional() },
  async (a) => (await yt.listAll("playlists", { part: "snippet,status,contentDetails", mine: true }, a.max || 50))
    .map((p) => ({ id: p.id, title: p.snippet.title, description: p.snippet.description, privacy: p.status.privacyStatus, items: p.contentDetails.itemCount })), RO);

tool("yt_playlist_items", "List videos in a playlist.", { playlist_id: z.string(), max: z.number().int().min(1).max(500).optional() },
  async (a) => (await yt.listAll("playlistItems", { part: "snippet,contentDetails", playlistId: a.playlist_id }, a.max || 50))
    .map((i) => ({ item_id: i.id, video_id: i.contentDetails.videoId, title: i.snippet.title, position: i.snippet.position })), RO);

tool("yt_create_playlist", "Create a playlist.",
  { title: z.string().max(150), description: z.string().optional(), privacy_status: z.enum(["public", "private", "unlisted"]).optional() },
  async (a) => { const p = await yt.post("playlists", { part: "snippet,status" }, { snippet: { title: a.title, description: a.description || "" }, status: { privacyStatus: a.privacy_status || "public" } }); return { id: p.id, title: p.snippet.title }; });

tool("yt_playlist_add", "Add a video to a playlist (optionally at a position).",
  { playlist_id: z.string(), video_id: z.string(), position: z.number().int().min(0).optional() },
  async (a) => { const r = await yt.post("playlistItems", { part: "snippet" }, { snippet: { playlistId: a.playlist_id, position: a.position, resourceId: { kind: "youtube#video", videoId: a.video_id } } }); return { item_id: r.id }; });

tool("yt_playlist_remove", "Remove an item from a playlist (uses item_id from yt_playlist_items).",
  { item_id: z.string(), confirm: z.boolean().optional() },
  async (a) => { requireConfirm(a, "remove a playlist item"); await yt.del("playlistItems", { id: a.item_id }); return "Removed."; }, DESTRUCTIVE);

// ---------- comments ----------
tool("yt_list_comments", "List comment threads on a video, or across the whole channel if video_id omitted. Includes replies.",
  { video_id: z.string().optional(), max: z.number().int().min(1).max(500).optional(), order: z.enum(["time", "relevance"]).optional(),
    moderation_status: z.enum(["published", "heldForReview", "likelySpam"]).optional(), search: z.string().optional() },
  async (a) => {
    const q = { part: "snippet,replies", order: a.order || "time", textFormat: "plainText", moderationStatus: a.moderation_status, searchTerms: a.search };
    if (a.video_id) q.videoId = a.video_id;
    else q.allThreadsRelatedToChannelId = (await yt.get("channels", { part: "id", mine: true })).items[0].id;
    return (await yt.listAll("commentThreads", q, a.max || 50)).map((t) => {
      const c = t.snippet.topLevelComment.snippet;
      return { thread_id: t.id, comment_id: t.snippet.topLevelComment.id, video_id: t.snippet.videoId, author: c.authorDisplayName, text: c.textDisplay, likes: c.likeCount, published: c.publishedAt, reply_count: t.snippet.totalReplyCount,
        replies: (t.replies?.comments || []).map((r) => ({ id: r.id, author: r.snippet.authorDisplayName, text: r.snippet.textDisplay })) };
    });
  }, RO);

tool("yt_reply_comment", "Reply publicly to a comment as the channel. Show the user the reply text before posting.",
  { parent_comment_id: z.string().describe("comment_id of the top-level comment"), text: z.string().min(1).max(10000) },
  async (a) => { const r = await yt.post("comments", { part: "snippet" }, { snippet: { parentId: a.parent_comment_id, textOriginal: a.text } }); return { id: r.id, posted: r.snippet.textDisplay }; });

tool("yt_moderate_comment", "Publish, hold, or reject (hide) comments; optionally ban the author. Requires confirm:true.",
  { comment_ids: z.array(z.string()).min(1).max(50), action: z.enum(["published", "heldForReview", "rejected"]), ban_author: z.boolean().optional(), confirm: z.boolean().optional() },
  async (a) => { requireConfirm(a, "moderate comments"); await yt.post("comments/setModerationStatus", { id: a.comment_ids.join(","), moderationStatus: a.action, banAuthor: a.ban_author && a.action === "rejected" ? true : undefined }, undefined); return `Set ${a.comment_ids.length} comment(s) to ${a.action}.`; }, DESTRUCTIVE);

// ---------- captions ----------
tool("yt_list_captions", "List caption tracks on a video.", { video_id: z.string() },
  async (a) => (await yt.get("captions", { part: "snippet", videoId: a.video_id }, 50)).items.map((c) => ({ id: c.id, language: c.snippet.language, name: c.snippet.name, kind: c.snippet.trackKind, draft: c.snippet.isDraft })), RO);

tool("yt_upload_caption", "Upload a caption file (.srt/.vtt/.sbv) to a video. Costs 400 quota units.",
  { video_id: z.string(), file_path: z.string(), language: z.string().describe("BCP-47, e.g. en, es, hi"), name: z.string().optional() },
  async (a) => { const r = await yt.resumableUpload("captions", { part: "snippet" }, { snippet: { videoId: a.video_id, language: a.language, name: a.name || "", isDraft: false } }, a.file_path, 400); return { id: r.id, language: r.snippet?.language }; });

// ---------- analytics ----------
tool("yt_analytics_overview", "Channel KPIs for a period: views, watch time, avg view duration, subscribers gained/lost, likes, shares, comments — plus a daily time series.",
  { ...dateArgs, daily: z.boolean().optional().describe("Include day-by-day breakdown (default true)") },
  async (a) => {
    const metrics = "views,estimatedMinutesWatched,averageViewDuration,averageViewPercentage,subscribersGained,subscribersLost,likes,dislikes,comments,shares";
    const totals = await runReport(a, { metrics });
    const out = { period: totals.period, totals: totals.rows[0] || {} };
    if (a.daily !== false) out.daily = (await runReport(a, { metrics: "views,estimatedMinutesWatched,subscribersGained,subscribersLost", dimensions: "day", sort: "day" })).rows;
    return out;
  }, RO);

tool("yt_analytics_top_videos", "Top videos by a metric over a period.",
  { ...dateArgs, metric: z.enum(["views", "estimatedMinutesWatched", "subscribersGained", "likes", "shares", "comments", "averageViewDuration"]).optional(), max: z.number().int().min(1).max(200).optional() },
  async (a) => {
    const m = a.metric || "views";
    const r = await runReport(a, { metrics: `views,estimatedMinutesWatched,averageViewDuration,averageViewPercentage,likes,comments,shares,subscribersGained`, dimensions: "video", sort: `-${m}`, maxResults: a.max || 10 });
    const titles = Object.fromEntries((await getVideos(r.rows.map((x) => x.video))).map((v) => [v.id, v.snippet.title]));
    return { period: r.period, sorted_by: m, videos: r.rows.map((x) => ({ title: titles[x.video], ...x })) };
  }, RO);

tool("yt_analytics_video", "Deep analytics for one video: totals, daily trend, traffic sources, audience retention curve.",
  { video_id: z.string(), ...dateArgs, include_retention: z.boolean().optional() },
  async (a) => {
    const f = { filters: `video==${a.video_id}` };
    const out = { video_id: a.video_id };
    out.totals = (await runReport(a, { ...f, metrics: "views,estimatedMinutesWatched,averageViewDuration,averageViewPercentage,likes,comments,shares,subscribersGained,subscribersLost" })).rows[0] || {};
    out.daily = (await runReport(a, { ...f, metrics: "views,estimatedMinutesWatched", dimensions: "day", sort: "day" })).rows;
    out.traffic_sources = (await runReport(a, { ...f, metrics: "views,estimatedMinutesWatched", dimensions: "insightTrafficSourceType", sort: "-views" })).rows;
    out.impressions_note = "Impressions & CTR are only available in YouTube Studio / Reporting API, not the Analytics API.";
    if (a.include_retention !== false) {
      out.retention = await runReport(a, { ...f, metrics: "audienceWatchRatio,relativeRetentionPerformance", dimensions: "elapsedVideoTimeRatio" })
        .then((r) => r.rows, (e) => `unavailable: ${e.message}`);
    }
    return out;
  }, RO);

tool("yt_analytics_audience", "Audience breakdown: age/gender, top countries, devices, operating systems, subscribed vs not.",
  { ...dateArgs, video_id: z.string().optional() },
  async (a) => {
    const f = a.video_id ? { filters: `video==${a.video_id}` } : {};
    const safe = (p) => p.then((r) => r.rows, (e) => `unavailable: ${e.message}`);
    return {
      age_gender: await safe(runReport(a, { ...f, metrics: "viewerPercentage", dimensions: "ageGroup,gender", sort: "gender,ageGroup" })),
      countries: await safe(runReport(a, { ...f, metrics: "views,estimatedMinutesWatched,subscribersGained", dimensions: "country", sort: "-views", maxResults: 25 })),
      devices: await safe(runReport(a, { ...f, metrics: "views,estimatedMinutesWatched", dimensions: "deviceType", sort: "-views" })),
      operating_systems: await safe(runReport(a, { ...f, metrics: "views", dimensions: "operatingSystem", sort: "-views", maxResults: 10 })),
      subscribed_status: await safe(runReport(a, { ...f, metrics: "views,estimatedMinutesWatched,averageViewDuration", dimensions: "subscribedStatus" })),
      content_type: await safe(runReport(a, { ...f, metrics: "views,estimatedMinutesWatched", dimensions: "creatorContentType", sort: "-views" })),
    };
  }, RO);

tool("yt_analytics_traffic", "Where views come from: traffic source types, top external sites, top search terms, playback locations.",
  { ...dateArgs, video_id: z.string().optional() },
  async (a) => {
    const f = a.video_id ? `video==${a.video_id};` : "";
    const safe = (p) => p.then((r) => r.rows, (e) => `unavailable: ${e.message}`);
    return {
      source_types: await safe(runReport(a, { metrics: "views,estimatedMinutesWatched", dimensions: "insightTrafficSourceType", sort: "-views", ...(f ? { filters: f.slice(0, -1) } : {}) })),
      search_terms: await safe(runReport(a, { metrics: "views", dimensions: "insightTrafficSourceDetail", filters: `${f}insightTrafficSourceType==YT_SEARCH`, sort: "-views", maxResults: 25 })),
      external_sites: await safe(runReport(a, { metrics: "views", dimensions: "insightTrafficSourceDetail", filters: `${f}insightTrafficSourceType==EXT_URL`, sort: "-views", maxResults: 25 })),
      suggested_by_videos: await safe(runReport(a, { metrics: "views", dimensions: "insightTrafficSourceDetail", filters: `${f}insightTrafficSourceType==RELATED_VIDEO`, sort: "-views", maxResults: 25 })),
      playback_locations: await safe(runReport(a, { metrics: "views,estimatedMinutesWatched", dimensions: "insightPlaybackLocationType", sort: "-views", ...(f ? { filters: f.slice(0, -1) } : {}) })),
    };
  }, RO);

tool("yt_analytics_revenue", "Revenue metrics (estimatedRevenue, adRevenue, cpm, playbackBasedCpm, monetizedPlaybacks). Requires YPP and login with monetary:true.",
  { ...dateArgs, daily: z.boolean().optional() },
  async (a) => {
    const metrics = "estimatedRevenue,estimatedAdRevenue,estimatedRedPartnerRevenue,cpm,playbackBasedCpm,monetizedPlaybacks,adImpressions";
    const out = { totals: (await runReport(a, { metrics })).rows[0] || {} };
    if (a.daily) out.daily = (await runReport(a, { metrics: "estimatedRevenue,monetizedPlaybacks", dimensions: "day", sort: "day" })).rows;
    return out;
  }, RO);

tool("yt_analytics_query",
  "Raw YouTube Analytics API query for anything not covered above. See https://developers.google.com/youtube/analytics/metrics and /dimensions. ids defaults to channel==MINE.",
  { ...dateArgs, metrics: z.string().describe("Comma-separated, e.g. views,likes"), dimensions: z.string().optional(), filters: z.string().optional(),
    sort: z.string().optional(), max_results: z.number().int().optional(), currency: z.string().optional() },
  async (a) => runReport(a, { metrics: a.metrics, dimensions: a.dimensions, filters: a.filters, sort: a.sort, maxResults: a.max_results, currency: a.currency }), RO);

// ---------- utility ----------
tool("yt_quota_usage", "Estimated YouTube Data API quota used by this server today.", {}, async () => yt.quotaUsage(), RO);

tool("yt_search_my_videos", "Search the channel's own videos by keyword (costs 100 quota units; prefer yt_list_videos for browsing).",
  { query: z.string(), max: z.number().int().min(1).max(50).optional() },
  async (a) => {
    const r = await yt.get("search", { part: "snippet", forMine: true, type: "video", q: a.query, maxResults: a.max || 10 }, 100);
    return r.items.map((i) => ({ id: i.id.videoId, title: i.snippet.title, published: i.snippet.publishedAt }));
  }, RO);

await server.connect(new StdioServerTransport());
