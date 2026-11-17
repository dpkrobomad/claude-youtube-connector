---
description: Upload and schedule a YouTube video or Short
argument-hint: "<video file path> [when]"
---
Upload and schedule: $ARGUMENTS

1. Confirm the file exists. Ask (if not given) for title, description, tags, publish time (convert to ISO 8601 with timezone), made-for-kids, AI disclosure, thumbnail, playlist.
2. Suggest an SEO-friendly title/description/tags if I want help.
3. Show me the final metadata and wait for my OK.
4. Call `yt_upload_video` with `publish_at`. Report the video URL, scheduled time, and any warning.
