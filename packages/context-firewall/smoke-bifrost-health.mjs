#!/usr/bin/env node

import assert from "node:assert/strict";
import http from "node:http";

import { createContextFirewallServer } from "./context-firewall.mjs";

function request(url) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.once("error", reject);
      response.once("end", () => resolve({
        status: response.statusCode,
        contentType: response.headers["content-type"],
        body: Buffer.concat(chunks),
      }));
    });
    req.setTimeout(3_000, () => req.destroy(new Error("Bifrost health canary timed out")));
    req.once("error", reject);
  });
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, () => resolve(server.address().port));
  });
}

function close(server) {
  return new Promise((resolve) => server.close(resolve));
}

const bifrostOrigin = process.env.SISO_BIFROST_ORIGIN ?? "http://127.0.0.1:8080";
const direct = await request(new URL("/health", bifrostOrigin));
assert.equal(direct.status, 200, "Bifrost must be healthy before the shadow canary");

const firewall = createContextFirewallServer({
  upstream: bifrostOrigin,
  metricsPath: "off",
  upstreamTimeoutMs: 3_000,
});

try {
  const firewallPort = await listen(firewall);
  const throughFirewall = await request(`http://127.0.0.1:${firewallPort}/health`);
  assert.equal(throughFirewall.status, direct.status);
  assert.equal(throughFirewall.contentType, direct.contentType);
  assert.deepEqual(throughFirewall.body, direct.body, "Bifrost health response entity-body must remain unchanged");

  const localHealth = await request(`http://127.0.0.1:${firewallPort}/__siso_context_firewall/health`);
  assert.deepEqual(JSON.parse(localHealth.body), {
    status: "ok",
    mode: "shadow",
    transformations: false,
    websocket: false,
  });

  console.log(JSON.stringify({
    verdict: "PASS",
    upstream: bifrostOrigin,
    upstream_status: direct.status,
    response_bytes: direct.body.length,
    mode: "shadow",
    transformations: false,
    provider_request_sent: false,
  }));
} finally {
  if (firewall.listening) await close(firewall);
}
