#!/usr/bin/env node

import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const sidecarScript = path.join(here, "headroom-sidecar.sh");
const oracleRoot = process.env.ORACLE_STREAMING_ROOT;
const headroomBin = process.env.HEADROOM_BIN;

assert(
  oracleRoot,
  "ORACLE_STREAMING_ROOT must point to an operator-supplied fixture repository",
);
assert(
  headroomBin,
  "HEADROOM_BIN must point to the audited Headroom executable",
);

function freePort() {
  return new Promise((resolve, reject) => {
    const server = http.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

function walkFiles(root) {
  const files = [];
  for (const name of readdirSync(root)) {
    const target = path.join(root, name);
    if (statSync(target).isDirectory()) files.push(...walkFiles(target));
    else files.push(target);
  }
  return files;
}

async function waitForReady(url, child) {
  let lastError;
  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (child.exitCode !== null)
      throw new Error(`Headroom exited early (${child.exitCode})`);
    try {
      const response = await fetch(`${url}/readyz`, {
        signal: AbortSignal.timeout(1000),
      });
      if (response.ok) return;
      lastError = new Error(`readyz returned ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw lastError || new Error("Headroom did not become ready");
}

const upstreamPort = await freePort();
const sidecarPort = await freePort();
const runtimeDir = mkdtempSync(path.join(os.tmpdir(), "siso-headroom-smoke-"));
let forwarded;

const upstream = http.createServer((request, response) => {
  const chunks = [];
  request.on("data", (chunk) => chunks.push(chunk));
  request.on("end", () => {
    const rawBody = Buffer.concat(chunks).toString("utf8");
    if (!rawBody) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end('{"status":"ok"}');
      return;
    }
    forwarded = {
      url: request.url,
      headers: request.headers,
      body: JSON.parse(rawBody),
    };
    const isOpenAiResponses = request.url === "/v1/responses";
    const isSeedTurn = forwarded.body.messages?.length === 1;
    const payload = JSON.stringify(
      isOpenAiResponses
        ? {
            id: "resp_oracle_codex_smoke",
            object: "response",
            status: "completed",
            model: "gpt-5.6-sol",
            output: [
              {
                type: "message",
                id: "msg_oracle_codex_smoke",
                status: "completed",
                role: "assistant",
                content: [
                  {
                    type: "output_text",
                    text: "oracle-codex-sidecar-ok",
                    annotations: [],
                  },
                ],
              },
            ],
            usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
          }
        : {
            id: "msg_oracle_smoke",
            type: "message",
            role: "assistant",
            model: "MiniMax-M3",
            content: isSeedTurn
              ? [
                  {
                    type: "tool_use",
                    id: "toolu_oracle_status",
                    name: "Bash",
                    input: { command: "git status --short" },
                  },
                ]
              : [{ type: "text", text: "oracle-sidecar-ok" }],
            stop_reason: isSeedTurn ? "tool_use" : "end_turn",
            stop_sequence: null,
            usage: { input_tokens: 1, output_tokens: 1 },
          },
    );
    response.writeHead(200, {
      "content-type": "application/json",
      "content-length": Buffer.byteLength(payload),
    });
    response.end(payload);
  });
});

await new Promise((resolve, reject) => {
  upstream.once("error", reject);
  upstream.listen(upstreamPort, "127.0.0.1", resolve);
});

const sidecar = spawn(sidecarScript, ["start"], {
  env: {
    ...process.env,
    HEADROOM_BIN: headroomBin,
    SISO_HEADROOM_PORT: String(sidecarPort),
    SISO_HEADROOM_RUNTIME_DIR: runtimeDir,
    SISO_HEADROOM_ANTHROPIC_UPSTREAM: `http://127.0.0.1:${upstreamPort}`,
    SISO_HEADROOM_OPENAI_UPSTREAM: `http://127.0.0.1:${upstreamPort}`,
  },
  stdio: ["ignore", "pipe", "pipe"],
});
const sidecarExit = new Promise((resolve) => sidecar.once("exit", resolve));

let sidecarOutput = "";
sidecar.stdout.on("data", (chunk) => (sidecarOutput += chunk));
sidecar.stderr.on("data", (chunk) => (sidecarOutput += chunk));

try {
  const sidecarUrl = `http://127.0.0.1:${sidecarPort}`;
  await waitForReady(sidecarUrl, sidecar);

  const oracleStatus = execFileSync(
    "git",
    ["-C", oracleRoot, "status", "--short"],
    {
      encoding: "utf8",
    },
  ).trim();
  assert(
    oracleStatus.length > 0,
    "Oracle proof fixture unexpectedly has no project status data",
  );
  const uniqueSentinel = `ORACLE_FIXTURE_${Date.now()}_DO_NOT_LOG`;
  const firstStatusLine = oracleStatus.split("\n")[0];
  const toolResult = `${uniqueSentinel}\n${`${firstStatusLine}\n`.repeat(600)}${oracleStatus}\n`;
  const systemPrompt =
    "ORACLE_SYSTEM_SENTINEL: preserve the shipping contract byte-for-byte.";
  const anthropicSystem = [
    {
      type: "text",
      text: systemPrompt,
      cache_control: { type: "ephemeral" },
    },
  ];
  const anthropicTools = Array.from({ length: 13 }, (_, index) => ({
    name: index === 0 ? "Bash" : `oracle_tool_${index}`,
    description: `Oracle fixture tool ${index}`,
    input_schema: {
      type: "object",
      $schema: "https://json-schema.org/draft/2020-12/schema",
      title: `Oracle tool ${index} input`,
      examples: [{ command: "git status --short" }],
      properties: { command: { type: "string" } },
      required: ["command"],
      additionalProperties: false,
    },
    ...(index === 12 ? { cache_control: { type: "ephemeral" } } : {}),
  }));
  const requestBody = {
    model: "MiniMax-M3",
    max_tokens: 64,
    stream: false,
    system: anthropicSystem,
    tools: anthropicTools,
    tool_choice: { type: "auto", disable_parallel_tool_use: false },
    messages: [
      {
        role: "user",
        content: [
          {
            type: "text",
            text: "Check the current oracle-streaming ship state.",
            cache_control: { type: "ephemeral" },
          },
        ],
      },
      {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "toolu_oracle_status",
            name: "Bash",
            input: { command: "git status --short" },
          },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "toolu_oracle_status",
            content: toolResult,
          },
        ],
      },
    ],
  };

  // Cache mode deliberately preserves the first request. Seed the stable
  // prefix, then append the tool-result delta exactly as a coding agent does.
  const seedBody = {
    ...requestBody,
    messages: requestBody.messages.slice(0, 1),
  };

  const ordinaryUserText = `${"ordinary-user-log-line\n".repeat(400)}KEEP_USER_TEXT_EXACT`;
  const ordinaryUserBody = {
    model: "MiniMax-M3",
    max_tokens: 16,
    stream: false,
    system: "ORACLE_USER_PROTECTION_SENTINEL",
    messages: [{ role: "user", content: ordinaryUserText }],
  };
  const ordinaryUserResponse = await fetch(`${sidecarUrl}/v1/messages`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": "oracle-smoke-key",
    },
    body: JSON.stringify(ordinaryUserBody),
    signal: AbortSignal.timeout(30000),
  });
  assert.equal(ordinaryUserResponse.status, 200);
  await ordinaryUserResponse.arrayBuffer();
  assert.deepEqual(forwarded.body.messages, ordinaryUserBody.messages);

  const listSeedBody = {
    model: "MiniMax-M3",
    max_tokens: 16,
    stream: false,
    system: "ORACLE_LIST_SHAPE_SENTINEL",
    messages: [{ role: "user", content: "Return the Bash tool call." }],
  };
  const listSeedResponse = await fetch(`${sidecarUrl}/v1/messages`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": "oracle-smoke-key",
      "x-headroom-project-id": "oracle-list-shape",
    },
    body: JSON.stringify(listSeedBody),
    signal: AbortSignal.timeout(30000),
  });
  assert.equal(listSeedResponse.status, 200);
  await listSeedResponse.arrayBuffer();
  const listFormMessages = [
    listSeedBody.messages[0],
    {
      role: "assistant",
      content: [
        {
          type: "tool_use",
          id: "toolu_oracle_status",
          name: "Bash",
          input: { command: "git status --short" },
        },
      ],
    },
    {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "toolu_oracle_status",
          content: [
            {
              type: "text",
              text: `${"LIST_FORM_REPEAT\n".repeat(600)}A`,
              metadata: { preserve: "first-block" },
            },
            {
              type: "text",
              text: `${"SECOND_BLOCK\n".repeat(100)}B`,
              metadata: { preserve: "second-block" },
            },
          ],
        },
      ],
    },
  ];
  const listFormResponse = await fetch(`${sidecarUrl}/v1/messages`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": "oracle-smoke-key",
      "x-headroom-project-id": "oracle-list-shape",
    },
    body: JSON.stringify({ ...listSeedBody, messages: listFormMessages }),
    signal: AbortSignal.timeout(30000),
  });
  assert.equal(listFormResponse.status, 200);
  await listFormResponse.arrayBuffer();
  const expectedListFormMessages = structuredClone(listFormMessages);
  expectedListFormMessages[2].content[0].cache_control = { type: "ephemeral" };
  assert.deepEqual(forwarded.body.messages, expectedListFormMessages);

  const seedResponse = await fetch(`${sidecarUrl}/v1/messages`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": "oracle-smoke-key",
    },
    body: JSON.stringify(seedBody),
    signal: AbortSignal.timeout(30000),
  });
  assert.equal(seedResponse.status, 200);
  await seedResponse.arrayBuffer();

  const response = await fetch(`${sidecarUrl}/v1/messages`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": "oracle-smoke-key",
    },
    body: JSON.stringify(requestBody),
    signal: AbortSignal.timeout(30000),
  });
  const responseBody = await response.json();
  assert.equal(response.status, 200);
  assert.equal(responseBody.content[0].text, "oracle-sidecar-ok");
  assert(
    forwarded,
    "Fake upstream did not receive the Headroom-forwarded request",
  );
  assert.equal(forwarded.url, "/v1/messages");
  assert.equal(forwarded.headers["x-api-key"], "oracle-smoke-key");
  assert.deepEqual(forwarded.body.system, anthropicSystem);
  assert.deepEqual(forwarded.body.tools, anthropicTools);
  assert.deepEqual(forwarded.body.tool_choice, requestBody.tool_choice);
  assert.equal(forwarded.body.messages.length, requestBody.messages.length);
  assert.equal(
    forwarded.body.messages[0].content[0].text,
    requestBody.messages[0].content[0].text,
  );
  assert.equal(
    "cache_control" in forwarded.body.messages[0].content[0],
    false,
  );
  assert.deepEqual(forwarded.body.messages[1], requestBody.messages[1]);
  assert.equal(
    forwarded.body.messages[2].content[0].tool_use_id,
    requestBody.messages[2].content[0].tool_use_id,
  );
  assert.deepEqual(forwarded.body.messages[2].content[0].cache_control, {
    type: "ephemeral",
  });

  const forwardedToolResult = forwarded.body.messages[2].content[0].content;
  assert(
    forwardedToolResult.length < toolResult.length,
    `Expected Oracle-shaped tool output to shrink (${forwardedToolResult.length} >= ${toolResult.length})`,
  );
  assert(
    forwardedToolResult.length / toolResult.length <= 0.95,
    `Expected at least 5% byte reduction, got ${(
      (1 - forwardedToolResult.length / toolResult.length) *
      100
    ).toFixed(2)}%`,
  );

  const codexSentinel = `ORACLE_CODEX_FIXTURE_${Date.now()}_DO_NOT_LOG`;
  const codexToolResult = `${codexSentinel}\n${`${firstStatusLine}\n`.repeat(600)}${oracleStatus}\n`;
  const codexInstructions =
    "ORACLE_CODEX_SYSTEM_SENTINEL: preserve the shipping contract byte-for-byte.";
  const codexTools = Array.from({ length: 13 }, (_, index) => ({
    type: "function",
    name: index === 0 ? "shell" : `oracle_tool_${index}`,
    description: `Oracle fixture tool ${index}`,
    parameters: {
      type: "object",
      $schema: "https://json-schema.org/draft/2020-12/schema",
      title: `Oracle tool ${index} input`,
      examples: [{ command: "git status --short" }],
      properties: { command: { type: "string" } },
      required: ["command"],
      additionalProperties: false,
    },
    strict: true,
  }));
  const codexRequestBody = {
    model: "gpt-5.6-sol",
    stream: false,
    instructions: codexInstructions,
    tools: codexTools,
    tool_choice: "auto",
    parallel_tool_calls: true,
    prompt_cache_key: "oracle-cache-prefix",
    input: [
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "Check the Oracle ship state." }],
      },
      {
        type: "function_call",
        call_id: "call_oracle_status",
        name: "shell",
        arguments: '{"command":"git status --short"}',
      },
      {
        type: "function_call_output",
        call_id: "call_oracle_status",
        output: codexToolResult,
      },
    ],
  };
  const codexResponse = await fetch(`${sidecarUrl}/v1/responses`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: "Bearer oracle-codex-smoke-key",
    },
    body: JSON.stringify(codexRequestBody),
    signal: AbortSignal.timeout(30000),
  });
  const codexResponseBody = await codexResponse.json();
  assert.equal(codexResponse.status, 200);
  assert.equal(
    codexResponseBody.output[0].content[0].text,
    "oracle-codex-sidecar-ok",
  );
  assert.equal(forwarded.url, "/v1/responses");
  assert.equal(
    forwarded.headers.authorization,
    "Bearer oracle-codex-smoke-key",
  );
  assert.equal(forwarded.body.instructions, codexInstructions);
  assert.deepEqual(forwarded.body.tools, codexTools);
  assert.equal(forwarded.body.tool_choice, codexRequestBody.tool_choice);
  assert.equal(
    forwarded.body.parallel_tool_calls,
    codexRequestBody.parallel_tool_calls,
  );
  assert.equal(
    forwarded.body.prompt_cache_key,
    codexRequestBody.prompt_cache_key,
  );
  assert.equal(forwarded.body.input.length, codexRequestBody.input.length);
  assert.deepEqual(forwarded.body.input[0], codexRequestBody.input[0]);
  assert.deepEqual(forwarded.body.input[1], codexRequestBody.input[1]);
  const forwardedCodexToolResult = forwarded.body.input.find(
    (item) => item.type === "function_call_output",
  ).output;
  assert(
    forwardedCodexToolResult.length < codexToolResult.length,
    `Expected Codex-shaped output to shrink (${forwardedCodexToolResult.length} >= ${codexToolResult.length})`,
  );
  assert(
    forwardedCodexToolResult.length / codexToolResult.length <= 0.95,
    `Expected at least 5% Codex byte reduction, got ${(
      (1 - forwardedCodexToolResult.length / codexToolResult.length) *
      100
    ).toFixed(2)}%`,
  );

  sidecar.kill("SIGTERM");
  await sidecarExit;
  const logs = walkFiles(runtimeDir)
    .map((file) => readFileSync(file, "utf8"))
    .join("\n");
  assert(
    !logs.includes(uniqueSentinel),
    "Stateless runtime log captured Oracle request content",
  );
  assert(
    !logs.includes(codexSentinel),
    "Stateless runtime log captured Oracle Codex request content",
  );
  assert(!sidecarOutput.includes(uniqueSentinel));
  assert(!sidecarOutput.includes(codexSentinel));
  assert(!sidecarOutput.includes("oracle-smoke-key"));

  console.log(
    JSON.stringify(
      {
        verdict: "PASS",
        fixture: oracleRoot,
        minimax_upstream_path: "/v1/messages",
        minimax_auth_forwarded: true,
        minimax_system_prompt_preserved: true,
        minimax_tool_schema_count_preserved: anthropicTools.length,
        minimax_cache_controls_preserved: true,
        minimax_message_cache_control_policy:
          "single_marker_moved_to_final_content_block",
        minimax_tool_pairing_preserved: true,
        minimax_ordinary_user_text_preserved: true,
        minimax_list_form_tool_result_preserved: true,
        minimax_tool_result_bytes_before: toolResult.length,
        minimax_tool_result_bytes_after: forwardedToolResult.length,
        minimax_byte_savings_percent: Number(
          ((1 - forwardedToolResult.length / toolResult.length) * 100).toFixed(
            2,
          ),
        ),
        codex_upstream_path: "/v1/responses",
        codex_auth_forwarded: true,
        codex_system_prompt_preserved: true,
        codex_tool_schema_count_preserved: codexTools.length,
        codex_cache_key_preserved: true,
        codex_tool_pairing_preserved: true,
        codex_tool_result_bytes_before: codexToolResult.length,
        codex_tool_result_bytes_after: forwardedCodexToolResult.length,
        codex_byte_savings_percent: Number(
          (
            (1 - forwardedCodexToolResult.length / codexToolResult.length) *
            100
          ).toFixed(2),
        ),
        request_content_absent_from_runtime_logs: true,
        sidecar_posture:
          "loopback/stateless/lossless/no-ccr/no-learn/no-cache/no-telemetry",
      },
      null,
      2,
    ),
  );
} catch (error) {
  sidecar.kill("SIGTERM");
  console.error(sidecarOutput);
  throw error;
} finally {
  await new Promise((resolve) => upstream.close(resolve));
  if (!sidecar.killed && sidecar.exitCode === null) {
    sidecar.kill("SIGTERM");
  }
  await sidecarExit;
  if (runtimeDir.startsWith(`${os.tmpdir()}${path.sep}siso-headroom-smoke-`)) {
    rmSync(runtimeDir, { recursive: true, force: true });
  }
}
