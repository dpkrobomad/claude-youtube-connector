---
description: YouTube performance report for a period
argument-hint: "[days, default 28]"
---
Build a YouTube performance report for the last ${ARGUMENTS:-28} days (end date = 2 days ago). Use `yt_analytics_overview`, `yt_analytics_top_videos` (max 10), `yt_analytics_traffic`, and `yt_analytics_audience`. Compare against the previous equal-length period with a second `yt_analytics_overview` call. Output: headline KPIs with % change, top videos table, traffic & audience highlights, and 3 concrete recommendations.
