#!/usr/bin/env node

import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

const headroomUrl = process.env.SISO_HEADROOM_URL || "http://127.0.0.1:18790";
const controlUrl =
  process.env.SISO_HEADROOM_CONTROL_URL ||
  "http://127.0.0.1:8080/anthropic";
const requestCount = Number.parseInt(
  process.env.SISO_HEADROOM_CANARY_REQUESTS || "20",
  10,
);
const runtimeRoot =
  process.env.SISO_HEADROOM_STATE_DIR ||
  path.join(process.env.HOME, ".local/state/siso-headroom");

assert(Number.isInteger(requestCount) && requestCount >= 20);
assert.equal(requestCount % 2, 0, "request count must split across two sessions");

const tools = Array.from({ length: 13 }, (_, index) => ({
  name: index === 0 ? "Bash" : `canary_tool_${index}`,
  description: `Read-only live-canary tool ${index}`,
  input_schema: {
    type: "object",
    $schema: "https://json-schema.org/draft/2020-12/schema",
    title: `Canary tool ${index} input`,
    properties: { command: { type: "string" } },
    required: ["command"],
    additionalProperties: false,
  },
  ...(index === 12 ? { cache_control: { type: "ephemeral" } } : {}),
}));

function percentile(values, percentileValue) {
  if (!values.length) return 0;
  const ordered = [...values].sort((left, right) => left - right);
  const index = Math.min(
    ordered.length - 1,
    Math.ceil((percentileValue / 100) * ordered.length) - 1,
  );
  return ordered[index];
}

function walkFiles(root) {
  const files = [];
  let names;
  try {
    names = readdirSync(root);
  } catch {
    return files;
  }
  for (const name of names) {
    const target = path.join(root, name);
    if (statSync(target).isDirectory()) files.push(...walkFiles(target));
    else files.push(target);
  }
  return files;
}

async function jsonFetch(url, body, sessionId) {
  const started = performance.now();
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": "siso-local-canary",
      "x-headroom-stack": "siso_live_canary",
      "x-headroom-project-id": sessionId,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(120000),
  });
  const elapsedMs = performance.now() - started;
  const raw = await response.text();
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`non-JSON provider response (status=${response.status})`);
  }
  if (!response.ok) {
    const errorType = parsed?.error?.type || parsed?.type || "unknown";
    throw new Error(`provider response ${response.status} (${errorType})`);
  }
  assert.equal(parsed.type, "message");
  return { parsed, elapsedMs };
}

async function createFixture(baseUrl, lane, sessionIndex, sentinel) {
  const sessionId = `siso-${lane}-${sessionIndex}-${Date.now()}`;
  const seedBody = {
    model: "Minimax/MiniMax-M3",
    // The seed establishes a stable real-provider prefix. It does not depend
    // on the model choosing a tool; the next request appends a structurally
    // valid synthetic tool-call/result pair, just like the Oracle fixture.
    max_tokens: 512,
    stream: false,
    system: [
      {
        type: "text",
        text: "This is a read-only context-efficiency canary.",
        cache_control: { type: "ephemeral" },
      },
    ],
    tools,
    tool_choice: { type: "auto", disable_parallel_tool_use: true },
    messages: [
      {
        role: "user",
        content:
          "Reply SEED_OK only. Do not call any tool.",
      },
    ],
  };
  const seed = await jsonFetch(
    `${baseUrl}/v1/messages`,
    seedBody,
    sessionId,
  );
  assert(
    Array.isArray(seed.parsed.content) && seed.parsed.content.length > 0,
    `provider seed response was empty (stop_reason=${
      seed.parsed.stop_reason || "unknown"
    })`,
  );
  const toolUse = {
    type: "tool_use",
    id: `toolu_siso_${lane}_${sessionIndex}`,
    name: "Bash",
    input: { command: "git status --short" },
  };

  // Exact repetition is losslessly foldable. Unique lines are intentionally
  // not removed by the hardened lossless-only lane.
  const repeatedStatus = "OK src/context/canary.ts unchanged\n".repeat(700);
  const toolResult = `${sentinel}\n${repeatedStatus}\nSUMMARY files=700 warnings=42 errors=0\n`;
  return {
    sessionId,
    seedLatencyMs: seed.elapsedMs,
    body: {
      ...seedBody,
      max_tokens: 24,
      messages: [
        seedBody.messages[0],
        { role: "assistant", content: seed.parsed.content },
        {
          role: "user",
          content: "Use this read-only status fixture for the canary.",
        },
        { role: "assistant", content: [toolUse] },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: toolUse.id,
              content: toolResult,
            },
          ],
        },
      ],
    },
  };
}

function usageTotals(responses) {
  const totals = {
    input_tokens: 0,
    cache_read_tokens: 0,
    cache_write_tokens: 0,
    output_tokens: 0,
  };
  for (const { parsed } of responses) {
    const usage = parsed.usage || {};
    totals.input_tokens += Number(usage.input_tokens || 0);
    totals.cache_read_tokens += Number(usage.cache_read_input_tokens || 0);
    totals.cache_write_tokens += Number(usage.cache_creation_input_tokens || 0);
    totals.output_tokens += Number(usage.output_tokens || 0);
  }
  const denominator =
    totals.input_tokens + totals.cache_read_tokens + totals.cache_write_tokens;
  return {
    ...totals,
    cache_read_share_percent:
      denominator > 0
        ? Number(((totals.cache_read_tokens / denominator) * 100).toFixed(2))
        : 0,
  };
}

const ready = await fetch(`${headroomUrl}/readyz`, {
  signal: AbortSignal.timeout(3000),
});
assert.equal(ready.status, 200, "Headroom is not ready");

const sentinel = `SISO_LIVE_HEADROOM_${Date.now()}_DO_NOT_LOG`;
const lanes = {
  control: { url: controlUrl, fixtures: [], responses: [] },
  headroom: { url: headroomUrl, fixtures: [], responses: [] },
};

for (const [lane, state] of Object.entries(lanes)) {
  state.fixtures = await Promise.all(
    [0, 1].map((sessionIndex) =>
      createFixture(state.url, lane, sessionIndex, sentinel),
    ),
  );
}

const requestsPerSession = requestCount / 2;
for (let round = 0; round < requestsPerSession; round += 1) {
  const batch = [];
  for (const state of Object.values(lanes)) {
    for (const fixture of state.fixtures) {
      batch.push(
        jsonFetch(
          `${state.url}/v1/messages`,
          fixture.body,
          fixture.sessionId,
        ).then((result) => state.responses.push(result)),
      );
    }
  }
  await Promise.all(batch);
}

const statsResponse = await fetch(`${headroomUrl}/stats`, {
  signal: AbortSignal.timeout(3000),
});
assert.equal(statsResponse.status, 200);
const stats = await statsResponse.json();

const runtimeContent = walkFiles(runtimeRoot)
  .map((file) => readFileSync(file, "utf8"))
  .join("\n");
assert(!runtimeContent.includes(sentinel), "Headroom runtime persisted canary content");

const controlUsage = usageTotals(lanes.control.responses);
const headroomUsage = usageTotals(lanes.headroom.responses);
const controlLatencies = lanes.control.responses.map((item) => item.elapsedMs);
const headroomLatencies = lanes.headroom.responses.map((item) => item.elapsedMs);
const compression = stats.summary?.compression || {};
  const overhead = stats.overhead || {};
const recentOptimizationLatencies = (stats.recent_requests || [])
  .filter((item) => item?.model === "Minimax/MiniMax-M3")
  .map((item) => Number(item.optimization_latency_ms || 0));

assert.equal(lanes.headroom.responses.length, requestCount);
assert.equal(lanes.control.responses.length, requestCount);
assert.equal(Number(stats.requests?.failed || 0), 0);
assert(
  Number(compression.requests_compressed || 0) > 0,
  "Headroom did not report any compressed live requests",
);

console.log(
  JSON.stringify(
    {
      verdict: "PASS",
      model: "Minimax/MiniMax-M3",
      sessions_per_lane: 2,
      requests_per_lane: requestCount,
      provider_errors: 0,
      headroom_failed_requests: Number(stats.requests?.failed || 0),
      headroom_requests_compressed: Number(
        compression.requests_compressed || 0,
      ),
      headroom_tokens_removed: Number(compression.total_tokens_removed || 0),
      headroom_average_compression_percent: Number(
        compression.avg_compression_pct || 0,
      ),
      control_usage: controlUsage,
      headroom_usage: headroomUsage,
      control_latency_ms: {
        median: Number(percentile(controlLatencies, 50).toFixed(2)),
        p95: Number(percentile(controlLatencies, 95).toFixed(2)),
      },
      headroom_latency_ms: {
        median: Number(percentile(headroomLatencies, 50).toFixed(2)),
        p95: Number(percentile(headroomLatencies, 95).toFixed(2)),
      },
      headroom_reported_overhead_ms: {
        average: Number(overhead.average_ms || 0),
        min: Number(overhead.min_ms || 0),
        max: Number(overhead.max_ms || 0),
        p95: Number(percentile(recentOptimizationLatencies, 95).toFixed(2)),
      },
      request_content_absent_from_runtime_files: true,
      duplicate_upstream_risk: "retry_max_attempts_1",
    },
    null,
    2,
  ),
);
