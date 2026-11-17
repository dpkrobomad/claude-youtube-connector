# YouTube Connector for Claude — Research, Plan & Gap Analysis

## Goal
A Claude Code plugin that connects a YouTube channel with a simple browser sign-in and lets Claude:
read analytics, read/edit video & post details, upload and schedule videos, manage playlists, comments, thumbnails and captions.

## Research summary

| Need | API | Scope |
|---|---|---|
| Channel / videos / playlists / comments read | YouTube Data API v3 | `youtube.readonly` |
| Edit metadata, upload, schedule, playlists, thumbnails, comment replies | YouTube Data API v3 | `youtube`, `youtube.upload`, `youtube.force-ssl` |
| Views, watch time, subs, traffic, demographics, geography, devices, retention | YouTube Analytics API v2 `reports.query` | `yt-analytics.readonly` |
| Revenue / CPM / ad metrics | YouTube Analytics API v2 | `yt-analytics-monetary.readonly` (YPP channels only) |
| Bulk daily dumps | YouTube Reporting API | (out of scope v1 — Analytics API covers interactive use) |

**Auth:** Google OAuth 2.0 "Desktop app" client, loopback redirect (`http://127.0.0.1:<random port>`) + PKCE.
The user clicks a link / browser opens, signs in, consents, done. Refresh token stored locally (0600) and auto-refreshed.

**Posting automation:** YouTube natively schedules: upload with `privacyStatus=private` + `status.publishAt` (ISO 8601). No daemon needed.
Resumable upload protocol handles large files.

## Architecture
```
.claude-plugin/plugin.json   plugin manifest
.claude-plugin/plugin.json  manifest + MCP server registration
server/index.js              MCP server: tool definitions
server/auth.js               OAuth loopback + PKCE, token store, refresh
server/youtube.js            REST client (fetch), resumable upload
skills/youtube/SKILL.md      how Claude should use the tools (quota, safety)
commands/*.md                /yt-login, /yt-report, /yt-schedule
```
No `googleapis` dependency — plain `fetch` keeps install small. Deps: `@modelcontextprotocol/sdk`, `zod`.

## Tools
Auth: `yt_auth_login`, `yt_auth_status`, `yt_auth_logout`
Channel: `yt_channel_info`
Videos: `yt_list_videos`, `yt_get_video`, `yt_update_video`, `yt_upload_video`, `yt_schedule_video`, `yt_set_thumbnail`, `yt_delete_video`
Playlists: `yt_list_playlists`, `yt_create_playlist`, `yt_playlist_add`
Comments: `yt_list_comments`, `yt_reply_comment`, `yt_moderate_comment`
Captions: `yt_list_captions`, `yt_upload_caption`
Analytics: `yt_analytics_query` (raw, any metric/dimension), `yt_analytics_overview`, `yt_analytics_video`, `yt_analytics_top_videos`, `yt_analytics_audience`, `yt_analytics_traffic`
Utility: `yt_quota_usage`, `yt_categories`

## Gap analysis (pass 1 → fixes)

| # | Gap | Resolution |
|---|---|---|
| 1 | Google requires an OAuth client ID; no way to ship a shared secret safely | One-time setup guide (`SETUP.md`); `YT_CLIENT_ID`/`YT_CLIENT_SECRET` env or `~/.config/claude-youtube/client_secret.json` (the file Google lets you download). Login tool returns exact setup steps if missing. |
| 2 | "Simple browser auth" — headless/remote sessions can't open a browser | Login tool auto-opens browser **and** returns the URL to click; loopback server waits up to 5 min. |
| 3 | Tokens expire hourly | Auto refresh with refresh_token; 401 → refresh once and retry. |
| 4 | Refresh token revoked / 7-day expiry for apps in "Testing" status | Detect `invalid_grant` → clear tokens, tell user to re-run login; SETUP.md says publish app to "In production" (personal use, unverified is fine) to avoid 7-day expiry. |
| 5 | Unverified API projects: uploads forced to **private** | Documented; tool warns when returned status ≠ requested. Fix = YouTube API audit form. |
| 6 | Quota: 10,000 units/day; upload = ~100 (was 1600), search = 100 | Local quota estimator (`yt_quota_usage`), skill tells Claude to prefer `playlistItems` over `search`. |
| 7 | Multiple channels (brand accounts) | Consent screen lets user pick channel; `yt_channel_info` confirms which. Tokens per profile via `YT_PROFILE` env. |
| 8 | Monetary metrics fail for non-YPP channels | Optional scope via `monetary: true` on login; clear error otherwise. |
| 9 | Analytics data lags 24–72h | Default end date = today-2 days; noted in output. |
| 10 | Shorts | Upload is identical (vertical, ≤3 min); `#Shorts` in title/description optional. |
| 11 | Community posts / Stories | **Not available in any public API** — documented limitation. |
| 12 | Destructive actions (delete video, comment moderation) | Require `confirm: true`; skill instructs Claude to ask user first. |
| 13 | Secrets leaking into chat | Tokens never returned by tools; file perms 0600. |
| 14 | Large uploads | Resumable upload streamed from disk in 8 MB chunks. |
| 15 | Recurring automation (e.g. weekly report) | Use Claude Code `/schedule` or `/loop` with `/yt-report`; documented. |

## Gap analysis (pass 2, after build) — see bottom of README "Known limitations".
