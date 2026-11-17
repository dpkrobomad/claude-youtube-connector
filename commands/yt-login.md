---
description: Connect your YouTube channel via browser sign-in
argument-hint: "[monetary]"
---
Connect YouTube. Call `yt_auth_status`; if the OAuth client isn't configured, show the setup steps. Otherwise call `yt_auth_login` (pass `monetary: true` if "$ARGUMENTS" contains "monetary"). If it is waiting, give me the sign-in link, then confirm with `yt_auth_status` once I've signed in.
