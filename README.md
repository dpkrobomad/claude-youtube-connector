# YouTube connector for Claude

Claude Code plugin (MCP server) that connects your YouTube channel with a browser sign-in and lets Claude:

- **Analytics** — channel KPIs + daily trend, top videos, per-video deep dive (retention curve, traffic), audience (age/gender, country, device, subscribed, Shorts vs long-form), traffic sources & search terms, revenue (YPP), raw query for any metric.
- **Post details** — list/get videos with stats, edit title/description/tags/category/privacy, made-for-kids & AI disclosure, thumbnails, captions.
- **Automated posting** — resumable upload of any size, native scheduling via `publish_at`, re-schedule/cancel, add to playlist, Shorts.
- **Community** — read comments channel-wide, reply, moderate (with confirmation); playlists.

## Install
```bash
cd /Users/admin/projects/claude_youtube_connector && npm install
```
```bash
claude plugin marketplace add /Users/admin/projects/claude_youtube_connector
```
```bash
claude plugin install youtube@youtube-connector
```
Then do the one-time Google setup in [SETUP.md](SETUP.md) and run `/yt-login`.

MCP-only (Claude Desktop or other clients): add `{"command":"node","args":["/abs/path/dist/server.mjs"]}` (self-contained bundle, no npm install needed; rebuild with `npm run build`) as an MCP server.

## Commands
- `/yt-login` — browser sign-in
- `/yt-report [days]` — performance report with period-over-period comparison and recommendations
- `/yt-schedule <file> [when]` — guided upload + schedule

Recurring automation: `/schedule` a weekly `/yt-report`, or keep a folder of videos and ask Claude to schedule them all from a CSV/plan.

## Tools (31)
`yt_auth_login/status/logout`, `yt_channel_info`, `yt_list_videos`, `yt_get_video`, `yt_update_video`, `yt_upload_video`, `yt_schedule_video`, `yt_set_thumbnail`, `yt_delete_video`, `yt_categories`, `yt_search_my_videos`, `yt_list_playlists`, `yt_playlist_items`, `yt_create_playlist`, `yt_playlist_add`, `yt_playlist_remove`, `yt_list_comments`, `yt_reply_comment`, `yt_moderate_comment`, `yt_list_captions`, `yt_upload_caption`, `yt_analytics_overview`, `yt_analytics_top_videos`, `yt_analytics_video`, `yt_analytics_audience`, `yt_analytics_traffic`, `yt_analytics_revenue`, `yt_analytics_query`, `yt_quota_usage`.

## Security
OAuth 2.0 + PKCE on a loopback port; state checked. Tokens stored `0600` in `~/.config/claude-youtube`, never returned to Claude. Logout revokes with Google. Delete/moderation tools need `confirm:true`.

## Gap analysis — pass 2 (after build)
| Gap found | Status |
|---|---|
| MCP tool call could hang 5 min waiting for login | Fixed: login returns link after `wait_seconds`, completes in background, `yt_auth_status` confirms |
| Plugin installed without `node_modules` | Fixed: `start.js` auto-installs on first launch (logs to stderr, keeps stdout clean for MCP) |
| Headless/SSH | Fixed: `YT_NO_BROWSER`, link returned, port-forward docs |
| `grossRevenue` is content-owner-only → would fail whole revenue query | Removed |
| Optional analytics breakdowns failing (e.g. small channels, privacy thresholds) | Each section degrades to `unavailable: <reason>` instead of failing |
| Updating video wipes unspecified fields (API replaces whole `snippet`) | Fixed: merge with current values before `videos.update` |
| Transient upload failures | Resumable chunks, exponential back-off, offset re-query |
| zod < 4.6.6 memory DoS advisory | Upgraded to zod 4 (0 vulnerabilities) |

### Remaining hard limits (YouTube platform, not fixable here)
- No API for Community posts, Stories, end screens, cards, or Studio "Impressions/CTR" (use Reporting API bulk jobs if needed).
- Unaudited Cloud projects: uploads locked private.
- 10k quota units/day default.
- Analytics latency 24–72h; small audiences hide demographic data.

## Test
```bash
npm test
```
Smoke tests cover tool registration, setup guidance, OAuth URL (PKCE/loopback/state rejection), and confirm-guards. Live API calls need your credentials.
