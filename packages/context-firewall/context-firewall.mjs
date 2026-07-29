#!/usr/bin/env node

import http from "node:http";
import https from "node:https";
import { constants as fsConstants } from "node:fs";
import { lstat, mkdir, open, rename } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";

import { estimateProviderPayloadMetrics } from "../context-core/provider-filter.js";
import { filterContextMessages, messageText } from "../context-core/filter.js";

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 18791;
const DEFAULT_MAX_BODY_BYTES = 32 * 1024 * 1024;
const DEFAULT_UPSTREAM_TIMEOUT_MS = 5 * 60 * 1000;
const DEFAULT_MAX_METRICS_BYTES = 16 * 1024 * 1024;
const DEFAULT_MAX_PENDING_METRICS = 1_024;
const HEALTH_PATH = "/__siso_context_firewall/health";
const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);
const REPLACEMENT_REASONS = [
  "noisy_tool_result",
  "large_tool_result",
  "old_tool_result",
  "duplicate_tool_result",
  "state_query_result",
];
const SAFE_UPSTREAM_ERROR_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ENETUNREACH",
  "ENOTFOUND",
  "EPIPE",
  "ETIMEDOUT",
  "UPSTREAM_TIMEOUT",
]);
const METRIC_METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]);
const METRIC_ERROR_CODES = new Set([
  "none",
  "CLIENT_DISCONNECTED",
  ...SAFE_UPSTREAM_ERROR_CODES,
  "UPSTREAM_ABORTED",
  "UPSTREAM_ERROR",
]);
const MODEL_BUCKETS = new Map([
  ["gpt-5.6-sol", "gpt_5_6_sol"],
  ["gpt-5.6-terra", "gpt_5_6_terra"],
  ["gpt-5.6-luna", "gpt_5_6_luna"],
  ["minimax-m3", "minimax_m3"],
]);

class BodyTooLargeError extends Error {
  constructor() {
    super("request body exceeds the configured shadow limit");
    this.name = "BodyTooLargeError";
  }
}

function finiteInteger(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function jsonChars(value) {
  try {
    return JSON.stringify(value).length;
  } catch {
    return 0;
  }
}

function safeErrorCode(error, fallback = "UPSTREAM_ERROR") {
  const code = typeof error?.code === "string" ? error.code : fallback;
  return SAFE_UPSTREAM_ERROR_CODES.has(code) ? code : fallback;
}

function metricMethod(value) {
  return METRIC_METHODS.has(value) ? value : "UNKNOWN";
}

function metricErrorCode(value) {
  return METRIC_ERROR_CODES.has(value) ? value : "UPSTREAM_ERROR";
}

function modelFamily(value) {
  if (typeof value !== "string") return "unknown";
  const normalized = value.trim().toLowerCase().split("/").at(-1);
  if (/^(minimax|abab)/.test(normalized)) return "minimax";
  if (/^(gpt|codex|o[1-9])/.test(normalized)) return "openai";
  if (/^(claude|anthropic)/.test(normalized)) return "anthropic";
  if (/^(gemini|google)/.test(normalized)) return "google";
  if (/^(grok|xai)/.test(normalized)) return "xai";
  return "unknown";
}

function modelBucket(value) {
  if (typeof value !== "string") return "unknown";
  const normalized = value.trim().toLowerCase().split("/").at(-1);
  return MODEL_BUCKETS.get(normalized) ?? "unknown";
}

export function isLoopbackHost(host) {
  return ["127.0.0.1", "::1"].includes(String(host ?? "").toLowerCase());
}

function parseUpstream(value) {
  const upstream = new URL(value);
  if (!["http:", "https:"].includes(upstream.protocol)) {
    throw new Error("context-firewall upstream must use http or https");
  }
  if (upstream.username || upstream.password || upstream.hash) {
    throw new Error("context-firewall upstream must not embed credentials or fragments");
  }
  return upstream;
}

function upstreamUrlFor(base, incoming) {
  const target = new URL(base);
  const basePath = target.pathname === "/" ? "" : target.pathname.replace(/\/$/, "");
  const incomingPath = incoming.pathname.startsWith("/") ? incoming.pathname : `/${incoming.pathname}`;
  target.pathname = basePath && (incomingPath === basePath || incomingPath.startsWith(`${basePath}/`))
    ? incomingPath
    : `${basePath}${incomingPath}` || "/";
  target.search = incoming.search;
  target.hash = "";
  return target;
}

function connectionHeaderTokens(headers) {
  const raw = headers.connection;
  const values = Array.isArray(raw) ? raw : [raw];
  return new Set(values
    .filter((value) => typeof value === "string")
    .flatMap((value) => value.split(","))
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean));
}

function forwardedRequestHeaders(headers, upstream, bodyLength) {
  const next = {};
  const connectionTokens = connectionHeaderTokens(headers);
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase();
    if (HOP_BY_HOP_HEADERS.has(lower) || connectionTokens.has(lower) || lower === "host" || lower === "content-length") continue;
    if (value !== undefined) next[lower] = value;
  }
  next.host = upstream.host;
  if (bodyLength > 0) next["content-length"] = String(bodyLength);
  return next;
}

function forwardedResponseHeaders(headers) {
  const next = {};
  const connectionTokens = connectionHeaderTokens(headers);
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase();
    if (HOP_BY_HOP_HEADERS.has(lower) || connectionTokens.has(lower) || value === undefined) continue;
    next[name] = value;
  }
  return next;
}

function collectBody(request, maxBodyBytes) {
  const declared = Number.parseInt(String(request.headers["content-length"] ?? ""), 10);
  if (Number.isFinite(declared) && declared > maxBodyBytes) {
    request.resume();
    return Promise.reject(new BodyTooLargeError());
  }

  return new Promise((resolve, reject) => {
    const chunks = [];
    let bytes = 0;
    let oversized = false;
    request.on("data", (chunk) => {
      bytes += chunk.length;
      if (bytes > maxBodyBytes) {
        oversized = true;
        chunks.length = 0;
        return;
      }
      if (!oversized) chunks.push(chunk);
    });
    request.once("aborted", () => reject(new Error("request aborted")));
    request.once("error", reject);
    request.once("end", () => {
      if (oversized) reject(new BodyTooLargeError());
      else resolve(Buffer.concat(chunks));
    });
  });
}

function protocolFor(pathname, payload) {
  if (/\/messages\/?$/.test(pathname) || Array.isArray(payload?.messages) && "max_tokens" in payload) return "anthropic_messages";
  if (/\/responses\/?$/.test(pathname) || Array.isArray(payload?.input)) return "openai_responses";
  if (/\/chat\/completions\/?$/.test(pathname)) return "openai_chat";
  return "unknown_json";
}

function toolResultsIn(item) {
  if (!item || typeof item !== "object") return [];
  if (["tool_result", "function_call_output"].includes(item.type)) return [item];
  if (["tool", "toolResult", "tool_result"].includes(item.role)) return [item];
  if (!Array.isArray(item.content)) return [];
  return item.content.filter((part) => part && typeof part === "object"
    && ["tool_result", "function_call_output"].includes(part.type));
}

function toolResultMetrics(payload) {
  const fields = [payload?.messages, payload?.input].filter(Array.isArray);
  let count = 0;
  let chars = 0;
  for (const items of fields) {
    for (const item of items) {
      for (const toolResult of toolResultsIn(item)) {
        count += 1;
        chars += messageText(toolResult).length;
      }
    }
  }
  return { count, chars };
}

function countKey(value, target) {
  const stack = [value];
  let count = 0;
  while (stack.length) {
    const current = stack.pop();
    if (!current || typeof current !== "object") continue;
    for (const [key, child] of Object.entries(current)) {
      if (key === target) count += 1;
      if (child && typeof child === "object") stack.push(child);
    }
  }
  return count;
}

function replacementCounts(replacements) {
  const counts = Object.fromEntries(REPLACEMENT_REASONS.map((reason) => [reason, 0]));
  let other = 0;
  for (const replacement of replacements) {
    if (Object.hasOwn(counts, replacement.reason)) counts[replacement.reason] += 1;
    else other += 1;
  }
  return {
    replacement_noisy_tool_result: counts.noisy_tool_result,
    replacement_large_tool_result: counts.large_tool_result,
    replacement_old_tool_result: counts.old_tool_result,
    replacement_duplicate_tool_result: counts.duplicate_tool_result,
    replacement_state_query_result: counts.state_query_result,
    replacement_other: other,
  };
}

function baseAnalysis(status, bodyBytes) {
  return {
    analysis_status: status,
    body_bytes: bodyBytes,
    model_family: "unknown",
    model_bucket: "unknown",
    protocol: "unknown",
    stream: false,
    message_items: 0,
    input_items: 0,
    tool_schema_count: 0,
    tool_schema_chars: 0,
    tool_result_count_before: 0,
    tool_result_chars_before: 0,
    tool_result_count_projected: 0,
    tool_result_chars_projected: 0,
    replacement_count: 0,
    replacement_noisy_tool_result: 0,
    replacement_large_tool_result: 0,
    replacement_old_tool_result: 0,
    replacement_duplicate_tool_result: 0,
    replacement_state_query_result: 0,
    replacement_other: 0,
    projected_saved_chars: 0,
    projected_saved_tokens: 0,
    would_transform: false,
    transformation_applied: false,
    cache_control_blocks: 0,
    prompt_cache_key_present: false,
  };
}

export function analyzeShadowRequest(body, contentType, rawRequestUrl = "/") {
  if (!body.length) return baseAnalysis("empty_body", 0);
  if (!String(contentType ?? "").toLowerCase().includes("json")) {
    return baseAnalysis("non_json_content_type", body.length);
  }

  let payload;
  try {
    payload = JSON.parse(body.toString("utf8"));
  } catch {
    return baseAnalysis("invalid_json", body.length);
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return baseAnalysis("unsupported_json_shape", body.length);
  }

  const fields = ["messages", "input"].filter((field) => Array.isArray(payload[field]));
  const before = estimateProviderPayloadMetrics(payload);
  const originalTools = Array.isArray(payload.tools) ? payload.tools : [];
  const analysis = {
    ...baseAnalysis(fields.length ? "ok" : "no_message_fields", body.length),
    model_family: modelFamily(payload.model),
    model_bucket: modelBucket(payload.model),
    protocol: protocolFor(new URL(rawRequestUrl || "/", "http://context-firewall.local").pathname, payload),
    stream: payload.stream === true,
    message_items: before.messageItems,
    input_items: before.inputItems,
    tool_schema_count: originalTools.length,
    tool_schema_chars: jsonChars(originalTools),
    cache_control_blocks: countKey(payload, "cache_control"),
    prompt_cache_key_present: typeof payload.prompt_cache_key === "string" && payload.prompt_cache_key.length > 0,
  };
  if (!fields.length) return analysis;

  const projected = { ...payload };
  const replacements = [];
  for (const field of fields) {
    const filtered = filterContextMessages(payload[field], {
      runId: "context-firewall-shadow",
      protectLast: 8,
    });
    projected[field] = filtered.messages;
    replacements.push(...filtered.replacements);
  }

  const after = estimateProviderPayloadMetrics(projected);
  const beforeTools = toolResultMetrics(payload);
  const projectedTools = toolResultMetrics(projected);
  const projectedSavedChars = Math.max(0, before.rawChars - after.rawChars);
  return {
    ...analysis,
    tool_result_count_before: beforeTools.count,
    tool_result_chars_before: beforeTools.chars,
    tool_result_count_projected: projectedTools.count,
    tool_result_chars_projected: projectedTools.chars,
    replacement_count: replacements.length,
    ...replacementCounts(replacements),
    projected_saved_chars: projectedSavedChars,
    projected_saved_tokens: Math.ceil(projectedSavedChars / 4),
    would_transform: replacements.length > 0,
  };
}

async function optionalLstat(path) {
  try {
    return await lstat(path);
  } catch (error) {
    if (error?.code === "ENOENT") return undefined;
    throw error;
  }
}

async function appendAggregateMetric(metricsPath, encoded, maxMetricsBytes) {
  const directory = dirname(metricsPath);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const flags = fsConstants.O_APPEND | fsConstants.O_CREAT | fsConstants.O_WRONLY
    | (fsConstants.O_NOFOLLOW ?? 0);
  const stat = await optionalLstat(metricsPath);
  if (stat) {
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("metrics target is not a regular file");
    if (stat.size + encoded.length > maxMetricsBytes) {
      const rotatedPath = `${metricsPath}.1`;
      const rotatedStat = await optionalLstat(rotatedPath);
      if (rotatedStat) {
        if (!rotatedStat.isFile() || rotatedStat.isSymbolicLink()) {
          throw new Error("rotated metrics target is not a regular file");
        }
      }
      await rename(metricsPath, rotatedPath);
    }
  }
  const descriptor = await open(metricsPath, flags, 0o600);
  try {
    await descriptor.chmod(0o600);
    await descriptor.writeFile(encoded);
  } finally {
    await descriptor.close();
  }
}

function createAggregateMetricWriter(metricsPath, maxMetricsBytes, maxPendingMetrics) {
  let pending = 0;
  let writeChain = Promise.resolve();
  const reportedErrors = new Set();
  const reportOnce = (message) => {
    if (reportedErrors.has(message)) return;
    reportedErrors.add(message);
    console.error(message);
  };

  const enqueue = (row) => {
    if (!metricsPath || metricsPath === "off") return;
    if (pending >= maxPendingMetrics) {
      reportOnce("context-firewall: aggregate metrics queue full; dropping rows");
      return;
    }

    let encoded;
    try {
      encoded = Buffer.from(`${JSON.stringify(row)}\n`);
      if (encoded.length > maxMetricsBytes) throw new Error("aggregate metric row exceeds ledger limit");
    } catch {
      reportOnce("context-firewall: aggregate metric encoding failed");
      return;
    }

    pending += 1;
    writeChain = writeChain.then(async () => {
      try {
        await appendAggregateMetric(metricsPath, encoded, maxMetricsBytes);
        reportedErrors.delete("context-firewall: aggregate metrics write failed");
      } catch {
        reportOnce("context-firewall: aggregate metrics write failed");
      } finally {
        pending -= 1;
      }
    });
  };

  return {
    enqueue,
    flush: () => writeChain,
  };
}

function writeJson(response, status, value) {
  const body = Buffer.from(JSON.stringify(value));
  response.writeHead(status, {
    "content-type": "application/json",
    "content-length": String(body.length),
    "cache-control": "no-store",
  });
  response.end(body);
}

function metricRow({ sequence, request, analysis, startedAt, responseStatus, responseBytes, errorCode = "none" }) {
  return {
    version: 1,
    timestamp: new Date().toISOString(),
    mode: "shadow",
    request_sequence: sequence,
    method: metricMethod(request.method),
    response_status: responseStatus,
    response_bytes: responseBytes,
    latency_ms: Math.max(0, Math.round(performance.now() - startedAt)),
    error_code: metricErrorCode(errorCode),
    ...analysis,
  };
}

function rejectUpgrade(_request, socket) {
  const body = Buffer.from('{"error":{"message":"context firewall shadow supports HTTP/SSE only"}}');
  const headers = Buffer.from([
    "HTTP/1.1 426 Upgrade Required",
    "Connection: close",
    "Content-Type: application/json",
    `Content-Length: ${body.length}`,
    "",
    "",
  ].join("\r\n"));
  socket.end(Buffer.concat([headers, body]));
}

function guardLoopbackListen(server, configuredHost) {
  const listen = server.listen.bind(server);
  server.listen = (...args) => {
    const [target, ...rest] = args;
    if (target && typeof target === "object") {
      if ("path" in target || !Number.isInteger(target.port) || target.port < 0) {
        throw new Error("context-firewall listen requires a numeric TCP port");
      }
      const requestedHost = target.host ?? configuredHost;
      if (!isLoopbackHost(requestedHost)) {
        throw new Error(`context-firewall refuses non-loopback host: ${requestedHost}`);
      }
      return listen({ ...target, host: requestedHost }, ...rest);
    }
    if (!Number.isInteger(target) || target < 0) {
      throw new Error("context-firewall listen requires a numeric TCP port");
    }
    if (typeof rest[0] === "string") {
      if (!isLoopbackHost(rest[0])) {
        throw new Error(`context-firewall refuses non-loopback host: ${rest[0]}`);
      }
      return listen(target, rest[0], ...rest.slice(1));
    }
    return listen(target, configuredHost, ...rest);
  };
}

export function createContextFirewallServer(options = {}) {
  const host = options.host ?? DEFAULT_HOST;
  if (!isLoopbackHost(host)) throw new Error(`context-firewall refuses non-loopback host: ${host}`);
  const upstream = parseUpstream(options.upstream);
  const maxBodyBytes = finiteInteger(options.maxBodyBytes, DEFAULT_MAX_BODY_BYTES);
  const upstreamTimeoutMs = finiteInteger(options.upstreamTimeoutMs, DEFAULT_UPSTREAM_TIMEOUT_MS);
  const maxMetricsBytes = finiteInteger(options.maxMetricsBytes, DEFAULT_MAX_METRICS_BYTES);
  const maxPendingMetrics = finiteInteger(options.maxPendingMetrics, DEFAULT_MAX_PENDING_METRICS);
  const metricsPath = options.metricsPath ?? join(homedir(), ".local", "state", "siso-context-firewall", "metrics.jsonl");
  const metricWriter = createAggregateMetricWriter(metricsPath, maxMetricsBytes, maxPendingMetrics);
  let sequence = 0;

  const server = http.createServer(async (request, response) => {
    let incomingUrl;
    try {
      incomingUrl = new URL(request.url || "/", "http://context-firewall.local");
    } catch {
      request.resume();
      writeJson(response, 400, { error: { message: "invalid request target" } });
      return;
    }
    if (request.method === "GET" && incomingUrl.pathname === HEALTH_PATH) {
      writeJson(response, 200, {
        status: "ok",
        mode: "shadow",
        transformations: false,
        websocket: false,
      });
      return;
    }

    const requestSequence = ++sequence;
    const startedAt = performance.now();
    let body;
    try {
      body = await collectBody(request, maxBodyBytes);
    } catch (error) {
      if (error instanceof BodyTooLargeError) {
        writeJson(response, 413, { error: { message: "request body exceeds shadow limit" } });
        return;
      }
      writeJson(response, 400, { error: { message: "request body could not be read" } });
      return;
    }

    let analysis;
    try {
      analysis = analyzeShadowRequest(body, request.headers["content-type"], request.url);
    } catch {
      analysis = baseAnalysis("analysis_error", body.length);
    }
    const target = upstreamUrlFor(upstream, incomingUrl);
    const transport = target.protocol === "https:" ? https : http;
    let responseBytes = 0;
    let responseStatus = 502;
    let metricCompleted = false;
    const completeMetric = (errorCode = "none") => {
      if (metricCompleted) return;
      metricCompleted = true;
      metricWriter.enqueue(metricRow({
        sequence: requestSequence,
        request,
        analysis,
        startedAt,
        responseStatus,
        responseBytes,
        errorCode,
      }));
    };
    let upstreamResponseRef;
    const upstreamRequest = transport.request(target, {
      method: request.method,
      headers: forwardedRequestHeaders(request.headers, target, body.length),
    }, (upstreamResponse) => {
      upstreamResponseRef = upstreamResponse;
      responseStatus = upstreamResponse.statusCode ?? 502;
      upstreamResponse.on("data", (chunk) => { responseBytes += chunk.length; });
      upstreamResponse.once("aborted", () => {
        completeMetric("UPSTREAM_ABORTED");
        if (!response.destroyed) response.destroy();
      });
      upstreamResponse.once("error", (error) => {
        completeMetric(safeErrorCode(error));
        if (!response.destroyed) response.destroy(error);
      });
      response.writeHead(responseStatus, forwardedResponseHeaders(upstreamResponse.headers));
      upstreamResponse.pipe(response);
    });

    upstreamRequest.once("error", (error) => {
      completeMetric(safeErrorCode(error));
      if (!response.headersSent) writeJson(response, 502, { error: { message: "context firewall upstream unavailable" } });
      else response.destroy();
    });
    upstreamRequest.setTimeout(upstreamTimeoutMs, () => {
      const error = new Error("context firewall upstream timed out");
      error.code = "UPSTREAM_TIMEOUT";
      upstreamRequest.destroy(error);
    });
    response.once("finish", () => completeMetric());
    response.once("error", (error) => {
      completeMetric(safeErrorCode(error, "CLIENT_DISCONNECTED"));
      upstreamResponseRef?.destroy();
      upstreamRequest.destroy();
    });
    response.once("close", () => {
      if (response.writableFinished) return;
      completeMetric("CLIENT_DISCONNECTED");
      upstreamResponseRef?.destroy();
      upstreamRequest.destroy();
    });
    if (body.length) upstreamRequest.write(body);
    upstreamRequest.end();
  });
  server.on("upgrade", rejectUpgrade);
  server.flushMetrics = () => metricWriter.flush();
  guardLoopbackListen(server, host);
  return server;
}

function main() {
  const mode = process.env.SISO_CONTEXT_FIREWALL_MODE ?? "shadow";
  if (mode !== "shadow") throw new Error("context-firewall currently supports shadow mode only");
  const upstream = process.env.SISO_CONTEXT_FIREWALL_UPSTREAM;
  if (!upstream) throw new Error("SISO_CONTEXT_FIREWALL_UPSTREAM is required");
  const host = process.env.SISO_CONTEXT_FIREWALL_HOST ?? DEFAULT_HOST;
  const port = finiteInteger(process.env.SISO_CONTEXT_FIREWALL_PORT, DEFAULT_PORT);
  const server = createContextFirewallServer({
    upstream,
    host,
    maxBodyBytes: finiteInteger(process.env.SISO_CONTEXT_FIREWALL_MAX_BODY_BYTES, DEFAULT_MAX_BODY_BYTES),
    upstreamTimeoutMs: finiteInteger(process.env.SISO_CONTEXT_FIREWALL_UPSTREAM_TIMEOUT_MS, DEFAULT_UPSTREAM_TIMEOUT_MS),
    maxMetricsBytes: finiteInteger(process.env.SISO_CONTEXT_FIREWALL_MAX_METRICS_BYTES, DEFAULT_MAX_METRICS_BYTES),
    metricsPath: process.env.SISO_CONTEXT_FIREWALL_METRICS_PATH,
  });
  server.listen(port, host, () => {
    console.log(`context-firewall: READY mode=shadow url=http://${host}:${port}`);
  });
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.once(signal, () => server.close(async () => {
      await server.flushMetrics();
      process.exit(0);
    }));
  }
}

const invokedDirectly = process.argv[1]
  && pathToFileURL(process.argv[1]).href === import.meta.url;
if (invokedDirectly) {
  try {
    main();
  } catch (error) {
    console.error(`context-firewall: ${error instanceof Error ? error.message : "startup failed"}`);
    process.exitCode = 1;
  }
}
