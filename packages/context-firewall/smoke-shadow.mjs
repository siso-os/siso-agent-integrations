#!/usr/bin/env node

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  analyzeShadowRequest,
  createContextFirewallServer,
} from "./context-firewall.mjs";

const PROMPT_SENTINEL = "PROMPT_SENTINEL_MUST_NOT_REACH_METRICS";
const AUTH_SENTINEL = "Bearer shadow-auth-sentinel-must-not-reach-metrics";
const RESPONSE_SENTINEL = "RESPONSE_SENTINEL_MUST_NOT_REACH_METRICS";
const TOOL_ARGUMENT_SENTINEL = "TOOL_ARGUMENT_MUST_NOT_REACH_METRICS";
const MODEL_SENTINEL = "shadow-model-sentinel-must-not-persist";
const METHOD_SENTINEL = "M-SEARCH";
const METRIC_KEYS = [
  "analysis_status",
  "body_bytes",
  "cache_control_blocks",
  "error_code",
  "input_items",
  "latency_ms",
  "message_items",
  "method",
  "mode",
  "model_bucket",
  "model_family",
  "projected_saved_chars",
  "projected_saved_tokens",
  "prompt_cache_key_present",
  "protocol",
  "replacement_count",
  "replacement_duplicate_tool_result",
  "replacement_large_tool_result",
  "replacement_noisy_tool_result",
  "replacement_old_tool_result",
  "replacement_other",
  "replacement_state_query_result",
  "request_sequence",
  "response_bytes",
  "response_status",
  "stream",
  "timestamp",
  "tool_result_chars_before",
  "tool_result_chars_projected",
  "tool_result_count_before",
  "tool_result_count_projected",
  "tool_schema_chars",
  "tool_schema_count",
  "transformation_applied",
  "version",
  "would_transform",
].sort();

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server.address().port));
  });
}

function close(server) {
  return new Promise((resolve) => server.close(resolve));
}

function request({ port, path, body = Buffer.alloc(0), headers = {}, method = "POST", contentLength = true }) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: "127.0.0.1",
      port,
      path,
      method,
      headers: {
        ...headers,
        ...(body.length && contentLength ? { "content-length": String(body.length) } : {}),
      },
    }, (res) => {
      const chunks = [];
      let dataEvents = 0;
      let firstChunkAt = 0;
      res.on("data", (chunk) => {
        dataEvents += 1;
        if (!firstChunkAt) firstChunkAt = Date.now();
        chunks.push(chunk);
      });
      res.once("error", reject);
      res.once("end", () => resolve({
        status: res.statusCode,
        headers: res.headers,
        body: Buffer.concat(chunks),
        dataEvents,
        firstChunkAt,
        endedAt: Date.now(),
      }));
    });
    req.once("error", reject);
    if (body.length) req.write(body);
    req.end();
  });
}

function disconnectAfterFirstChunk({ port, path, body, headers = {} }) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: "127.0.0.1",
      port,
      path,
      method: "POST",
      headers: {
        ...headers,
        "content-length": String(body.length),
      },
    }, (res) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        resolve();
      };
      res.once("data", () => res.destroy());
      res.once("close", finish);
      res.once("error", finish);
    });
    req.once("error", reject);
    req.end(body);
  });
}

function upgradeRequest(port) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, "127.0.0.1", () => {
      socket.write([
        "GET /v1/responses HTTP/1.1",
        `Host: 127.0.0.1:${port}`,
        "Connection: Upgrade",
        "Upgrade: websocket",
        "",
        "",
      ].join("\r\n"));
    });
    const chunks = [];
    socket.on("data", (chunk) => chunks.push(chunk));
    socket.once("error", reject);
    socket.once("end", () => resolve(Buffer.concat(chunks)));
  });
}

function rawRequest(port, requestLine) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, "127.0.0.1", () => {
      socket.write([
        requestLine,
        `Host: 127.0.0.1:${port}`,
        "Connection: close",
        "",
        "",
      ].join("\r\n"));
    });
    const chunks = [];
    socket.setTimeout(1_000, () => {
      socket.destroy();
      reject(new Error("raw request timed out"));
    });
    socket.on("data", (chunk) => chunks.push(chunk));
    socket.once("error", reject);
    socket.once("end", () => resolve(Buffer.concat(chunks)));
  });
}

async function waitForMetrics(path, count) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const rows = readFileSync(path, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
      if (rows.length >= count) return rows;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`metrics did not reach ${count} rows`);
}

const runtimeDirectory = mkdtempSync(join(tmpdir(), "siso-context-firewall-smoke-"));
const metricsPath = join(runtimeDirectory, "state", "metrics.jsonl");
const forwarded = [];
const sseBody = Buffer.from([
  `event: response.output_text.delta\ndata: {"delta":"${RESPONSE_SENTINEL}"}\n\n`,
  "event: response.completed\ndata: {\"type\":\"response.completed\"}\n\n",
].join(""));

const upstream = http.createServer((req, res) => {
  const chunks = [];
  req.on("data", (chunk) => chunks.push(chunk));
  req.on("end", () => {
    const body = Buffer.concat(chunks);
    forwarded.push({
      path: req.url,
      body,
      authorization: req.headers.authorization,
      apiKey: req.headers["x-api-key"],
      requestHopSecret: req.headers["x-hop-secret"],
    });
    if (req.url === "/v1/timeout") return;
    if (req.url?.startsWith("/v1/responses?stream=1")) {
      res.writeHead(207, {
        "content-type": "text/event-stream",
        "x-shadow-upstream": "sse",
        connection: "keep-alive, x-upstream-hop",
        "x-upstream-hop": "must-be-stripped",
      });
      res.write(sseBody.subarray(0, 31));
      const delayMs = req.url.includes("disconnect=1") ? 250 : 30;
      setTimeout(() => res.end(sseBody.subarray(31)), delayMs);
      return;
    }
    const responseBody = Buffer.from(JSON.stringify({ ok: true, marker: RESPONSE_SENTINEL }));
    res.writeHead(201, {
      "content-type": "application/json",
      "x-shadow-upstream": "json",
      "content-length": String(responseBody.length),
    });
    res.end(responseBody);
  });
});

let upstreamPort;
let firewall;
let defaultBindFirewall;
let rotationFirewall;
let unsafeMetricsFirewall;
try {
  upstreamPort = await listen(upstream);
  firewall = createContextFirewallServer({
    upstream: `http://127.0.0.1:${upstreamPort}/v1`,
    metricsPath,
    maxBodyBytes: 100_000,
    upstreamTimeoutMs: 250,
  });
  const firewallPort = await listen(firewall);

  assert.throws(
    () => createContextFirewallServer({ upstream: `http://127.0.0.1:${upstreamPort}`, host: "0.0.0.0" }),
    /refuses non-loopback/,
  );
  assert.throws(
    () => createContextFirewallServer({ upstream: `http://127.0.0.1:${upstreamPort}`, host: "localhost" }),
    /refuses non-loopback/,
  );
  const unsafeBindAttempt = createContextFirewallServer({
    upstream: `http://127.0.0.1:${upstreamPort}`,
    metricsPath: "off",
  });
  assert.throws(() => unsafeBindAttempt.listen(0, "0.0.0.0"), /refuses non-loopback/);
  assert.throws(() => unsafeBindAttempt.listen({ port: 0, host: "::" }), /refuses non-loopback/);
  assert.throws(() => unsafeBindAttempt.listen(join(runtimeDirectory, "firewall.sock")), /numeric TCP port/);
  assert.throws(() => unsafeBindAttempt.listen({ fd: 10 }), /numeric TCP port/);
  defaultBindFirewall = createContextFirewallServer({
    upstream: `http://127.0.0.1:${upstreamPort}`,
    metricsPath: "off",
  });
  await new Promise((resolve, reject) => {
    defaultBindFirewall.once("error", reject);
    defaultBindFirewall.listen(0, resolve);
  });
  assert.equal(defaultBindFirewall.address().address, "127.0.0.1");
  await close(defaultBindFirewall);
  defaultBindFirewall = undefined;

  const health = await request({ port: firewallPort, path: "/__siso_context_firewall/health", method: "GET" });
  assert.equal(health.status, 200);
  assert.deepEqual(JSON.parse(health.body), {
    status: "ok",
    mode: "shadow",
    transformations: false,
    websocket: false,
  });
  assert.equal(forwarded.length, 0, "health must remain local");

  for (const target of ["http://[", "http://%", "//[", "http://[::1"]) {
    const malformedTarget = await rawRequest(firewallPort, `GET ${target} HTTP/1.1`);
    assert.match(malformedTarget.toString("utf8"), /^HTTP\/1\.1 400 Bad Request/);
  }
  const healthAfterMalformedTarget = await request({
    port: firewallPort,
    path: "/__siso_context_firewall/health",
    method: "GET",
  });
  assert.equal(healthAfterMalformedTarget.status, 200, "malformed targets must not poison the server");
  assert.equal(forwarded.length, 0, "malformed targets must not reach upstream");

  const anthropicPayload = {
    model: MODEL_SENTINEL,
    max_tokens: 32,
    stream: false,
    system: `system ${PROMPT_SENTINEL}`,
    tools: [{
      name: "Bash",
      description: "run shell",
      input_schema: { type: "object", properties: { command: { type: "string" } } },
    }],
    messages: [
      { role: "user", content: `user ${PROMPT_SENTINEL}` },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "bounded reasoning", signature: "static-signature" },
          {
            type: "tool_use",
            id: "toolu-shadow",
            name: "Bash",
            input: { command: `printf ${TOOL_ARGUMENT_SENTINEL}` },
          },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "toolu-shadow",
            is_error: false,
            cache_control: { type: "ephemeral" },
            content: `${PROMPT_SENTINEL}\n${"A".repeat(9000)}`,
          },
          {
            type: "tool_result",
            tool_use_id: "toolu-shadow-image",
            content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: "AA==" } }],
          },
        ],
      },
    ],
  };
  const anthropicBody = Buffer.from(` \n${JSON.stringify(anthropicPayload)}\n`);
  const anthropic = await request({
    port: firewallPort,
    path: "/v1/messages",
    body: anthropicBody,
    headers: {
      "content-type": "application/json",
      "x-api-key": AUTH_SENTINEL,
      connection: "keep-alive, x-hop-secret",
      "x-hop-secret": AUTH_SENTINEL,
    },
  });
  assert.equal(anthropic.status, 201);
  assert.equal(anthropic.headers["x-shadow-upstream"], "json");
  assert.equal(forwarded[0].path, "/v1/messages");
  assert.equal(forwarded[0].apiKey, AUTH_SENTINEL);
  assert.equal(forwarded[0].requestHopSecret, undefined);
  assert.deepEqual(forwarded[0].body, anthropicBody, "shadow request bytes must remain unchanged");
  assert.match(anthropic.body.toString("utf8"), new RegExp(RESPONSE_SENTINEL));

  const responsesPayload = {
    model: "gpt-5.6-sol",
    stream: true,
    prompt_cache_key: "stable-shadow-key",
    previous_response_id: "resp_static_previous",
    input: [
      { role: "user", content: [{ type: "input_text", text: PROMPT_SENTINEL }] },
      {
        type: "function_call",
        call_id: "call-shadow",
        name: "shell",
        arguments: JSON.stringify({ command: TOOL_ARGUMENT_SENTINEL }),
      },
      {
        type: "function_call_output",
        call_id: "call-shadow",
        output: `${PROMPT_SENTINEL}\n${"B".repeat(8500)}`,
      },
    ],
  };
  const responsesBody = Buffer.from(`\n${JSON.stringify(responsesPayload)} \n`);
  const responsesPath = "/v1/responses?stream=1&a=1&a=2&plus=hello+world&esc=%2F&empty=";
  const responses = await request({
    port: firewallPort,
    path: responsesPath,
    body: responsesBody,
    headers: {
      "content-type": "application/json",
      authorization: AUTH_SENTINEL,
    },
  });
  assert.equal(responses.status, 207);
  assert.equal(responses.headers["x-shadow-upstream"], "sse");
  assert.equal(responses.headers["x-upstream-hop"], undefined);
  assert.deepEqual(responses.body, sseBody, "SSE response bytes must remain unchanged");
  assert.ok(responses.dataEvents >= 2, "delayed SSE chunks must reach the client incrementally");
  assert.ok(responses.firstChunkAt < responses.endedAt, "the first SSE chunk must arrive before stream completion");
  assert.equal(forwarded[1].path, responsesPath);
  assert.equal(forwarded[1].authorization, AUTH_SENTINEL);
  assert.deepEqual(forwarded[1].body, responsesBody, "Responses request bytes must remain unchanged");

  const repeatedResponses = await request({
    port: firewallPort,
    path: responsesPath,
    body: responsesBody,
    headers: {
      "content-type": "application/json",
      authorization: AUTH_SENTINEL,
    },
  });
  assert.deepEqual(repeatedResponses.body, sseBody);
  assert.deepEqual(forwarded[2].body, forwarded[1].body, "repeated cache-prefix request bodies must be byte-identical");

  const chatPayload = {
    model: "gpt-5.6-terra",
    messages: [
      { role: "user", content: PROMPT_SENTINEL },
      {
        role: "assistant",
        tool_calls: [{
          id: "chat-call-shadow",
          type: "function",
          function: { name: "shell", arguments: JSON.stringify({ command: TOOL_ARGUMENT_SENTINEL }) },
        }],
      },
      {
        role: "tool",
        tool_call_id: "chat-call-shadow",
        content: `${PROMPT_SENTINEL}\n${"C".repeat(8500)}`,
      },
    ],
  };
  const chatBody = Buffer.from(JSON.stringify(chatPayload));
  const chat = await request({
    port: firewallPort,
    path: "/v1/chat/completions",
    body: chatBody,
    headers: { "content-type": "application/json", authorization: AUTH_SENTINEL },
  });
  assert.equal(chat.status, 201);
  assert.deepEqual(forwarded[3].body, chatBody, "Chat Completions request bytes must remain unchanged");

  const upgrade = await upgradeRequest(firewallPort);
  assert.match(upgrade.toString("utf8"), /^HTTP\/1\.1 426 Upgrade Required/);
  const [upgradeHeaders, upgradeBody] = upgrade.toString("utf8").split("\r\n\r\n");
  assert.equal(Number(/content-length: (\d+)/i.exec(upgradeHeaders)?.[1]), Buffer.byteLength(upgradeBody));

  const invalidBody = Buffer.from(`not-json-${PROMPT_SENTINEL}`);
  const invalid = await request({
    port: firewallPort,
    path: "/v1/messages?invalid=1",
    body: invalidBody,
    method: METHOD_SENTINEL,
    headers: { "content-type": "application/json" },
  });
  assert.equal(invalid.status, 201);
  assert.deepEqual(forwarded[4].body, invalidBody, "analysis failures must fail open");

  const deepBody = Buffer.from(`${'{"x":'.repeat(12_000)}0${"}".repeat(12_000)}`);
  const deep = await request({
    port: firewallPort,
    path: "/v1/messages?deep=1",
    body: deepBody,
    headers: { "content-type": "application/json" },
  });
  assert.equal(deep.status, 201);
  assert.deepEqual(forwarded[5].body, deepBody, "pathological valid JSON must still fail open to original bytes");

  const exactLimitBody = Buffer.alloc(100_000, 76);
  const exactLimit = await request({
    port: firewallPort,
    path: "/v1/messages?exact-limit=1",
    body: exactLimitBody,
    headers: { "content-type": "application/octet-stream" },
  });
  assert.equal(exactLimit.status, 201);
  assert.deepEqual(forwarded[6].body, exactLimitBody, "a body exactly at the limit must forward unchanged");

  const oversized = await request({
    port: firewallPort,
    path: "/v1/messages",
    body: Buffer.alloc(100_001, 88),
    headers: { "content-type": "application/json" },
  });
  assert.equal(oversized.status, 413);
  assert.equal(forwarded.length, 7, "declared oversized requests must not reach upstream");

  const chunkedOversized = await request({
    port: firewallPort,
    path: "/v1/messages?chunked-oversized=1",
    body: Buffer.alloc(100_001, 89),
    contentLength: false,
    headers: { "content-type": "application/octet-stream" },
  });
  assert.equal(chunkedOversized.status, 413);
  assert.equal(forwarded.length, 7, "chunked oversized requests must not reach upstream");

  const timedOut = await request({
    port: firewallPort,
    path: "/v1/timeout",
    body: Buffer.from("{}"),
    headers: { "content-type": "application/json" },
  });
  assert.equal(timedOut.status, 502);
  assert.equal(forwarded.length, 8, "timeout fixture must reach the fake upstream once");

  await firewall.flushMetrics();
  const metrics = readFileSync(metricsPath, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
  assert.equal(metrics.length, 8);
  for (const metric of metrics) {
    assert.deepEqual(Object.keys(metric).sort(), METRIC_KEYS, "aggregate metric schema must remain closed");
    assert.match(metric.timestamp, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    assert.ok(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS", "UNKNOWN"].includes(metric.method));
    assert.ok(["none", "CLIENT_DISCONNECTED", "ECONNREFUSED", "ECONNRESET", "ENETUNREACH", "ENOTFOUND", "EPIPE", "ETIMEDOUT", "UPSTREAM_ABORTED", "UPSTREAM_ERROR", "UPSTREAM_TIMEOUT"].includes(metric.error_code));
    assert.ok(["ok", "empty_body", "non_json_content_type", "invalid_json", "unsupported_json_shape", "no_message_fields", "analysis_error"].includes(metric.analysis_status));
    assert.ok(["minimax", "openai", "anthropic", "google", "xai", "unknown"].includes(metric.model_family));
    assert.ok(["gpt_5_6_sol", "gpt_5_6_terra", "gpt_5_6_luna", "minimax_m3", "unknown"].includes(metric.model_bucket));
    assert.ok(["anthropic_messages", "openai_responses", "openai_chat", "unknown_json", "unknown"].includes(metric.protocol));
    assert.equal(metric.mode, "shadow");
  }
  assert.equal(metrics[0].protocol, "anthropic_messages");
  assert.equal(metrics[0].model_family, "unknown");
  assert.equal(metrics[0].model_bucket, "unknown");
  assert.equal(metrics[0].would_transform, true);
  assert.equal(metrics[0].transformation_applied, false);
  assert.equal(metrics[0].replacement_large_tool_result, 1);
  assert.ok(metrics[0].projected_saved_chars > 0);
  assert.equal(metrics[1].protocol, "openai_responses");
  assert.equal(metrics[1].model_family, "openai");
  assert.equal(metrics[1].model_bucket, "gpt_5_6_sol");
  assert.equal(metrics[1].stream, true);
  assert.equal(metrics[1].prompt_cache_key_present, true);
  assert.equal(metrics[1].replacement_large_tool_result, 1);
  assert.equal(metrics[1].response_bytes, sseBody.length);
  assert.equal(metrics[2].protocol, "openai_responses");
  assert.equal(metrics[2].prompt_cache_key_present, true);
  assert.equal(metrics[3].protocol, "openai_chat");
  assert.equal(metrics[3].model_bucket, "gpt_5_6_terra");
  assert.equal(metrics[3].would_transform, true);
  assert.equal(metrics[4].analysis_status, "invalid_json");
  assert.equal(metrics[4].method, "UNKNOWN");
  assert.equal(metrics[4].would_transform, false);
  assert.equal(metrics[5].analysis_status, "no_message_fields");
  assert.equal(metrics[5].transformation_applied, false);
  assert.equal(metrics[6].analysis_status, "non_json_content_type");
  assert.equal(metrics[6].body_bytes, 100_000);
  assert.equal(metrics[7].error_code, "UPSTREAM_TIMEOUT");
  assert.equal(metrics[7].response_status, 502);

  await disconnectAfterFirstChunk({
    port: firewallPort,
    path: `${responsesPath}&disconnect=1`,
    body: responsesBody,
    headers: {
      "content-type": "application/json",
      authorization: AUTH_SENTINEL,
    },
  });
  const metricsAfterDisconnect = await waitForMetrics(metricsPath, 9);
  await firewall.flushMetrics();
  assert.equal(metricsAfterDisconnect.length, 9, "one client disconnect must produce one metric row");
  assert.equal(metricsAfterDisconnect[8].error_code, "CLIENT_DISCONNECTED");
  assert.equal(metricsAfterDisconnect[8].response_status, 207);
  assert.ok(metricsAfterDisconnect[8].response_bytes < sseBody.length);

  const metricsRaw = readFileSync(metricsPath, "utf8");
  for (const sentinel of [PROMPT_SENTINEL, AUTH_SENTINEL, RESPONSE_SENTINEL, TOOL_ARGUMENT_SENTINEL, MODEL_SENTINEL, METHOD_SENTINEL]) {
    assert.doesNotMatch(metricsRaw, new RegExp(sentinel));
  }
  assert.equal(statSync(metricsPath).mode & 0o777, 0o600);
  assert.equal(statSync(join(runtimeDirectory, "state")).mode & 0o777, 0o700);

  const directAnalysis = analyzeShadowRequest(anthropicBody, "application/json", "/v1/messages");
  assert.equal(directAnalysis.transformation_applied, false);
  assert.equal(directAnalysis.tool_result_count_before, directAnalysis.tool_result_count_projected);
  assert.ok(directAnalysis.tool_result_chars_projected < directAnalysis.tool_result_chars_before);
  const minimaxAnalysis = analyzeShadowRequest(
    Buffer.from('{"model":"Minimax/MiniMax-M3","messages":[]}'),
    "application/json",
    "/v1/messages",
  );
  assert.equal(minimaxAnalysis.model_bucket, "minimax_m3");
  const solAnalysis = analyzeShadowRequest(
    Buffer.from('{"model":"CodexOpenAI/gpt-5.6-sol","messages":[]}'),
    "application/json",
    "/v1/messages",
  );
  assert.equal(solAnalysis.model_bucket, "gpt_5_6_sol");

  const unsafeMetricsDirectory = join(runtimeDirectory, "unsafe-metrics");
  const unsafeMetricsPath = join(unsafeMetricsDirectory, "metrics.jsonl");
  mkdirSync(unsafeMetricsDirectory, { recursive: true });
  symlinkSync(metricsPath, unsafeMetricsPath);
  unsafeMetricsFirewall = createContextFirewallServer({
    upstream: `http://127.0.0.1:${upstreamPort}`,
    metricsPath: unsafeMetricsPath,
  });
  const unsafeMetricsPort = await listen(unsafeMetricsFirewall);
  const originalConsoleError = console.error;
  const metricWriteErrors = [];
  console.error = (...args) => metricWriteErrors.push(args.join(" "));
  try {
    const telemetryFailureResponse = await request({
      port: unsafeMetricsPort,
      path: "/v1/telemetry-failure",
      body: Buffer.from("x"),
      headers: { "content-type": "application/octet-stream" },
    });
    assert.equal(telemetryFailureResponse.status, 201);
    assert.match(telemetryFailureResponse.body.toString("utf8"), new RegExp(RESPONSE_SENTINEL));
    await unsafeMetricsFirewall.flushMetrics();
  } finally {
    console.error = originalConsoleError;
  }
  assert.deepEqual(metricWriteErrors, ["context-firewall: aggregate metrics write failed"]);
  await close(unsafeMetricsFirewall);
  unsafeMetricsFirewall = undefined;

  const rotationMetricsPath = join(runtimeDirectory, "rotation", "metrics.jsonl");
  rotationFirewall = createContextFirewallServer({
    upstream: `http://127.0.0.1:${upstreamPort}`,
    metricsPath: rotationMetricsPath,
    maxMetricsBytes: 2_000,
    maxPendingMetrics: 64,
  });
  const rotationPort = await listen(rotationFirewall);
  const concurrentStreams = await Promise.all(Array.from({ length: 12 }, (_, index) => request({
    port: rotationPort,
    path: `/v1/responses?stream=1&rotation=${index}`,
    body: Buffer.from("x"),
    headers: { "content-type": "application/octet-stream" },
  })));
  for (const streamed of concurrentStreams) {
    assert.equal(streamed.status, 207);
    assert.deepEqual(streamed.body, sseBody, "concurrent SSE bytes must remain unchanged");
    assert.ok(streamed.dataEvents >= 2, "concurrent SSE chunks must stay incremental");
  }
  await rotationFirewall.flushMetrics();
  const retainedRotationMetrics = [];
  for (const ledgerPath of [rotationMetricsPath, `${rotationMetricsPath}.1`]) {
    assert.ok(statSync(ledgerPath).size <= 2_000, "rotating aggregate ledgers must stay within their cap");
    for (const line of readFileSync(ledgerPath, "utf8").trim().split("\n").filter(Boolean)) {
      const row = JSON.parse(line);
      retainedRotationMetrics.push(row);
      assert.equal(row.mode, "shadow");
      assert.equal(row.response_status, 207);
      assert.equal(row.response_bytes, sseBody.length);
      assert.equal(row.error_code, "none");
    }
  }
  assert.equal(
    new Set(retainedRotationMetrics.map((row) => row.request_sequence)).size,
    retainedRotationMetrics.length,
    "serialized rotation must not duplicate metric rows",
  );
  await close(rotationFirewall);
  rotationFirewall = undefined;

  console.log("SISO_CONTEXT_FIREWALL_SHADOW_SMOKE_OK");
} finally {
  if (unsafeMetricsFirewall?.listening) await close(unsafeMetricsFirewall);
  if (rotationFirewall?.listening) await close(rotationFirewall);
  if (defaultBindFirewall?.listening) await close(defaultBindFirewall);
  if (firewall?.listening) await close(firewall);
  if (upstream.listening) await close(upstream);
  rmSync(runtimeDirectory, { recursive: true, force: true });
}
