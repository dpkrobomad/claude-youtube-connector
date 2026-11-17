import { test } from "node:test";
import assert from "node:assert";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const cfg = fs.mkdtempSync(path.join(os.tmpdir(), "yt-"));
async function connect(env = {}) {
  const c = new Client({ name: "t", version: "1" });
  await c.connect(new StdioClientTransport({ command: process.execPath, args: ["server/start.js"], env: { ...process.env, YT_CONFIG_DIR: cfg, YT_CLIENT_ID: "", YT_CLIENT_SECRET: "", ...env } }));
  return c;
}
const text = (r) => r.content[0].text;

test("lists all tools", async () => {
  const c = await connect();
  const { tools } = await c.listTools();
  assert.ok(tools.length >= 28, `got ${tools.length}`);
  for (const n of ["yt_auth_login", "yt_upload_video", "yt_analytics_overview", "yt_schedule_video"]) assert.ok(tools.find((t) => t.name === n), n);
  await c.close();
});

test("status without client shows setup", async () => {
  const c = await connect();
  const s = JSON.parse(text(await c.callTool({ name: "yt_auth_status", arguments: {} })));
  assert.equal(s.client_configured, false); assert.match(s.setup, /Desktop app/);
  const r = await c.callTool({ name: "yt_auth_login", arguments: { wait_seconds: 0 } });
  assert.ok(r.isError); assert.match(text(r), /console.cloud.google.com/);
  await c.close();
});

test("not signed in error", async () => {
  const c = await connect({ YT_CLIENT_ID: "x", YT_CLIENT_SECRET: "y" });
  const r = await c.callTool({ name: "yt_channel_info", arguments: {} });
  assert.ok(r.isError); assert.match(text(r), /yt_auth_login/);
  await c.close();
});

test("login returns URL with PKCE and loopback", async () => {
  const c = await connect({ YT_CLIENT_ID: "abc.apps.googleusercontent.com", YT_CLIENT_SECRET: "y", YT_NO_BROWSER: "1" });
  const s = JSON.parse(text(await c.callTool({ name: "yt_auth_login", arguments: { wait_seconds: 0 } })));
  assert.equal(s.status, "waiting_for_user");
  const u = new URL(s.sign_in_url);
  assert.equal(u.searchParams.get("code_challenge_method"), "S256");
  assert.match(u.searchParams.get("redirect_uri"), /^http:\/\/127\.0\.0\.1:\d+\/callback$/);
  // simulate a bad-state callback → must be rejected, login still pending
  const bad = await fetch(u.searchParams.get("redirect_uri") + "?code=x&state=wrong");
  assert.equal(bad.status, 400);
  // simulate user cancelling
  await fetch(u.searchParams.get("redirect_uri") + "?error=access_denied&state=" + u.searchParams.get("state"));
  const r = await c.callTool({ name: "yt_auth_login", arguments: { wait_seconds: 0 } });
  assert.ok(r.isError || JSON.parse(text(r)).status === "waiting_for_user");
  await c.close();
});

test("destructive tools require confirm", async () => {
  const c = await connect({ YT_CLIENT_ID: "x", YT_CLIENT_SECRET: "y" });
  const r = await c.callTool({ name: "yt_delete_video", arguments: { video_id: "abc" } });
  assert.ok(r.isError); assert.match(text(r), /confirm:true/);
  await c.close();
});
