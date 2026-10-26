// Exercise the real standalone HTTP server without a production DB or session.
import assert from "node:assert/strict";

const origin = process.env.SMOKE_ORIGIN ?? "http://127.0.0.1:8080";
async function request(path) {
  return fetch(new URL(path, origin), { redirect: "manual" });
}

let ready = false;
for (let attempt = 0; attempt < 60; attempt++) {
  try {
    if ((await request("/login")).status === 200) {
      ready = true;
      break;
    }
  } catch { /* server is starting */ }
  await new Promise((resolve) => setTimeout(resolve, 1000));
}
assert.ok(ready, "standalone server did not become ready");
const home = await request("/");
assert.equal(home.status, 307, "unauthenticated record access must redirect");
assert.equal(new URL(home.headers.get("location"), origin).pathname, "/login");
const login = await request("/login");
const html = await login.text();
assert.match(html, /Google/);
const script = html.match(/src="(\/_next\/static\/[^"<>]+\.js)"/);
assert.ok(script, "login must reference a bundled client script");
const asset = await request(script[1]);
assert.equal(asset.status, 200, "standalone must include .next/static");
assert.match(asset.headers.get("content-type") ?? "", /javascript/);
const worker = await request("/sw.js");
assert.equal(worker.status, 200, "standalone must include public assets");
assert.match(worker.headers.get("content-type") ?? "", /javascript/);
const manifest = await request("/manifest.webmanifest");
assert.equal(manifest.status, 200);
assert.equal((await manifest.json()).short_name, "mfmf");
console.log("Cloud Run container: login, auth redirect, JavaScript, service worker and manifest passed.");
