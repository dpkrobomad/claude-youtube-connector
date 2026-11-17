#!/usr/bin/env node
// Terminal sign-in: `npm run login` (add --monetary for revenue metrics).
import { login, status } from "./auth.js";
try {
  await login({
    monetary: process.argv.includes("--monetary"),
    onUrl: (url, opened) => console.log(`${opened ? "Browser opened." : "Open this URL:"}\n${url}\n\nWaiting for sign-in…`),
  });
  console.log("✅ YouTube connected.", JSON.stringify(status(), null, 2));
} catch (e) { console.error("❌", e.message); process.exit(1); }
