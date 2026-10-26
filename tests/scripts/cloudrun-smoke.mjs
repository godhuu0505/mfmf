// Exercise the real standalone HTTP server without a production DB or session.
import assert from "node:assert/strict";

const origin = process.env.SMOKE_ORIGIN ?? "http://127.0.0.1:8080";
async function request(path, options = {}) {
  return fetch(new URL(path, origin), {
    ...options,
    redirect: "manual",
    signal: AbortSignal.timeout(5000),
  });
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

// Cloud Run terminates TLS and forwards a public Host to a standalone server bound to 0.0.0.0.
// Route Handler request.url may use that internal bind address; it must never escape in Location.
const proxyHeaders = {
  host: "mfmf-test.example", "x-forwarded-proto": "https",
  "x-forwarded-host": "untrusted.example", forwarded: "host=untrusted.example;proto=https",
};
const invite = await request("/invite/proxy-smoke", { headers: proxyHeaders });
assert.equal(invite.status, 307);
assert.equal(invite.headers.get("location"), "/login?next=%2Finvite%2Fproxy-smoke");
const callback = await request("/auth/callback?error=access_denied", {
  headers: { ...proxyHeaders, cookie: "mfmf-post-login-next=%2Finvite%2Fproxy-smoke" },
});
assert.equal(callback.status, 307);
assert.equal(callback.headers.get("location"), "/login?next=%2Finvite%2Fproxy-smoke&error=oauth");
const signout = await request("/auth/signout", {
  method: "POST", headers: { ...proxyHeaders, origin: "https://mfmf-test.example" },
  body: new URLSearchParams({ next: "/invite/proxy-smoke" }),
});
assert.equal(signout.status, 303);
assert.equal(signout.headers.get("location"), "/login?next=%2Finvite%2Fproxy-smoke");
const cookieUpdate = await request("/auth/next", {
  method: "POST", headers: { ...proxyHeaders, origin: "https://mfmf-test.example", "sec-fetch-site": "same-origin" },
  body: new URLSearchParams({ next: "/invite/proxy-smoke" }),
});
assert.equal(cookieUpdate.status, 204);
assert.match(cookieUpdate.headers.get("set-cookie") ?? "", /mfmf-post-login-next=/);
for (const site of ["cross-site", "same-site", "none", "unknown", null]) {
  const rejected = await request("/auth/next", {
    method: "POST", headers: { ...proxyHeaders, origin: "https://untrusted.example", ...(site ? { "sec-fetch-site": site } : {}) },
    body: new URLSearchParams({ next: "/invite/attacker" }),
  });
  assert.equal(rejected.status, 403, `unsafe next-cookie POST must fail: ${site}`);
  assert.equal(rejected.headers.get("set-cookie"), null);
}
console.log("Cloud Run container: assets, proxy auth redirects and same-origin cookie protection passed.");
