# One-time Google setup (~3 minutes)

Google requires every app that reads/edits YouTube to have its own OAuth client. You create it once; after that, connecting is just a browser sign-in.

1. https://console.cloud.google.com/ → create a project (e.g. "Claude YouTube").
2. **APIs & Services → Library** → enable **YouTube Data API v3** and **YouTube Analytics API**.
3. **OAuth consent screen** → User type **External** → fill app name + your email → add your Google account under **Test users**.
   Then **Publish app** (to "In production"). You'll see an "unverified app" warning when signing in — click *Advanced → Go to app*. This is fine for personal use and stops refresh tokens expiring every 7 days.
4. **Credentials → Create credentials → OAuth client ID → Desktop app**. Download the JSON.
5. Save it as `~/.config/claude-youtube/client_secret.json`
   (or export `YT_CLIENT_ID` / `YT_CLIENT_SECRET`).

Then in Claude: `/yt-login` (or `npm run login` in this folder).

## Public uploads from an unverified project
YouTube locks videos uploaded by **unaudited** API projects to *private*. To publish public/scheduled uploads via API, submit the
[YouTube API Services audit form](https://support.google.com/youtube/contact/yt_api_form). Until then: upload as private and flip it public in Studio, or use `yt_update_video` (also restricted until audit).

## Options
| Env var | Purpose |
|---|---|
| `YT_PROFILE` | Separate token per channel/account (e.g. `brand2`) |
| `YT_CONFIG_DIR` | Where tokens & client file live (default `~/.config/claude-youtube`) |
| `YT_NO_BROWSER=1` | Don't auto-open a browser; just return the link (SSH/remote) |

Remote/SSH: the sign-in redirects to `127.0.0.1:<port>` on the machine running Claude. Forward that port (`ssh -L <port>:127.0.0.1:<port>`) or run `npm run login` locally and copy `tokens-default.json` across.
