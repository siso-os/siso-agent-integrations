#!/usr/bin/env node
import http from 'node:http';
import https from 'node:https';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
import { homedir } from 'node:os';
import { join } from 'node:path';

const listenHost = process.env.CODEX_BIFROST_NORMALIZER_HOST || '127.0.0.1';
const listenPort = Number(process.env.CODEX_BIFROST_NORMALIZER_PORT || 8083);
const upstream = new URL(process.env.CODEX_BIFROST_UPSTREAM || 'http://127.0.0.1:8080');
const anthropicUpstream = new URL(process.env.CODEX_BIFROST_ANTHROPIC_UPSTREAM || 'http://127.0.0.1:8080');
const openAIUpstream = new URL(process.env.CODEX_OPENAI_UPSTREAM || 'https://chatgpt.com');
const claudeAdapterEnabled = process.env.CODEX_BIFROST_FABLE_ADAPTER === '1';
const claudeKeychainAccount = process.env.CODEX_BIFROST_CLAUDE_KEYCHAIN_ACCOUNT || process.env.USER || 'shaansisodia';
const taskInbox = join(homedir(), '.codex', 'task-inbox');
const claudeOAuthBeta = [
  'claude-code-20250219',
  'oauth-2025-04-20',
  'interleaved-thinking-2025-05-14',
  'thinking-token-count-2026-05-13',
  'context-management-2025-06-27',
  'prompt-caching-scope-2026-01-05',
  'mid-conversation-system-2026-04-07',
  'advisor-tool-2026-03-01',
  'effort-2025-11-24',
  'structured-outputs-2025-12-15',
].join(',');
const claudeAdapterModels = new Set([
  'claude-fable-5-1',
  'claude-fable-5',
  'claude-opus-5',
  'claude-opus-4-8',
  'claude-opus-4-7',
  'claude-sonnet-5',
  'claude-sonnet-4-6',
  'claude-sonnet-4-5',
  'claude-haiku-4-5-20251001',
]);
const claudeAgentIdentitySystemBlock = {
  type: 'text',
  text: "You are a Claude agent, built on Anthropic's Claude Agent SDK.",
  cache_control: { type: 'ephemeral' },
};

function normalizeCodexModelAlias(value) {
  if (typeof value !== 'string') return value;
  const canonicalModel = value.replace(/\[(?:500k|1m)\]$/, '');
  if (canonicalModel === value) return value;
  console.log(JSON.stringify({
    event: 'normalized_model_alias',
    requested_model: value,
    canonical_model: canonicalModel,
  }));
  return canonicalModel;
}

function canonicalClaudeModel(value) {
  if (typeof value !== 'string') return null;
  const withoutProvider = value.includes('/') ? value.slice(value.indexOf('/') + 1) : value;
  const canonical = withoutProvider.replace(/\[(?:500k|1m)\]$/, '');
  return claudeAdapterModels.has(canonical) ? canonical : null;
}

function isNativeOpenAIModel(value) {
  return typeof value === 'string' && /^(?:gpt-|o[134](?:-|$))/.test(value);
}

function readClaudeOAuthAccessToken() {
  try {
    const raw = execFileSync('/usr/bin/security', [
      'find-generic-password',
      '-s', 'Claude Code-credentials',
      '-a', claudeKeychainAccount,
      '-w',
    ], { encoding: 'utf8', maxBuffer: 128 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
    const oauth = JSON.parse(raw).claudeAiOauth;
    if (typeof oauth?.accessToken !== 'string' || oauth.accessToken.length === 0) {
      throw new Error('Claude OAuth access token is unavailable');
    }
    if (Number.isFinite(oauth.expiresAt) && oauth.expiresAt <= Date.now()) {
      throw new Error('Claude OAuth access token expired; run Claude Code once to refresh it');
    }
    return oauth.accessToken;
  } catch (error) {
    if (error instanceof Error && error.message.includes('expired')) throw error;
    throw new Error('Claude OAuth credentials are unavailable for the Claude adapter');
  }
}

function normalizeInterAgentInputItems(value) {
  if (!value || typeof value !== 'object' || !Array.isArray(value.input)) return [];

  const converted = [];
  value.input = value.input.map((item) => {
    if (!item || item.type !== 'agent_message' || !Array.isArray(item.content)) return item;

    const plaintext = item.content
      .filter((part) => part?.type === 'input_text' && typeof part.text === 'string')
      .map((part) => part.text)
      .join('\n');
    const isEncrypted = item.content.some((part) => part?.type === 'encrypted_content');
    const taskKey = String(item.recipient || '').split('/').filter(Boolean).at(-1);
    const safeTaskKey = taskKey && /^[a-z0-9_]+$/.test(taskKey) ? taskKey : null;
    if (!plaintext && !isEncrypted) return item;

    const payload = isEncrypted && safeTaskKey
      ? [
          'The collaboration payload is encrypted for the OpenAI backend and is not readable by this local provider.',
          `Read the authoritative task packet: ${join(taskInbox, `${safeTaskKey}.md`)}`,
          'Treat that file as the complete assignment. Do not infer work from the task name or conversation history.',
        ].join('\n')
      : plaintext;

    converted.push({
      mode: isEncrypted ? 'task_packet' : 'plaintext',
      task_key: safeTaskKey,
      chars: payload.length,
      sha256: createHash('sha256').update(payload).digest('hex'),
    });
    return {
      type: 'message',
      role: 'user',
      content: [{
        type: 'input_text',
        text: [
          'Message Type: NEW_TASK',
          `Task name: ${item.recipient || 'unknown'}`,
          `Sender: ${item.author || 'unknown'}`,
          'Payload:',
          payload,
        ].join('\n'),
      }],
    };
  });

  return converted;
}

function sendJson(response, status, value) {
  const body = Buffer.from(JSON.stringify(value));
  response.writeHead(status, {
    'content-type': 'application/json',
    'content-length': String(body.length),
    'cache-control': 'no-store',
  });
  response.end(body);
}

function writeSseEvent(response, state, eventType, value) {
  const event = { ...value, type: eventType, sequence_number: state.sequence++ };
  response.write(`event: ${eventType}\ndata: ${JSON.stringify(event)}\n\n`);
}

function messageTextParts(item) {
  if (!Array.isArray(item?.content)) return [];
  return item.content.filter((part) => part?.type === 'output_text' && typeof part.text === 'string');
}

function writeSyntheticResponseStream(response, payload) {
  const state = { sequence: 0 };
  const output = Array.isArray(payload.output)
    ? payload.output.filter((item) => item?.type !== 'reasoning')
    : [];
  const responseBase = { ...payload, output: [] };

  response.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-store',
    connection: 'keep-alive',
    'x-codex-bifrost-normalizer': '1',
    'x-codex-bifrost-buffered-stream': '1',
  });

  writeSseEvent(response, state, 'response.created', {
    response: { ...responseBase, status: 'in_progress' },
  });
  writeSseEvent(response, state, 'response.in_progress', {
    response: { ...responseBase, status: 'in_progress' },
  });

  output.forEach((item, outputIndex) => {
    if (item?.type === 'message') {
      const textParts = messageTextParts(item);
      writeSseEvent(response, state, 'response.output_item.added', {
        output_index: outputIndex,
        item: { ...item, status: 'in_progress', content: [] },
      });
      textParts.forEach((part, contentIndex) => {
        const emptyPart = { ...part, text: '' };
        writeSseEvent(response, state, 'response.content_part.added', {
          output_index: outputIndex,
          content_index: contentIndex,
          item_id: item.id,
          part: emptyPart,
        });
        writeSseEvent(response, state, 'response.output_text.delta', {
          output_index: outputIndex,
          content_index: contentIndex,
          item_id: item.id,
          delta: part.text,
          logprobs: Array.isArray(part.logprobs) ? part.logprobs : [],
        });
        writeSseEvent(response, state, 'response.output_text.done', {
          output_index: outputIndex,
          content_index: contentIndex,
          item_id: item.id,
          text: part.text,
          logprobs: Array.isArray(part.logprobs) ? part.logprobs : [],
        });
        writeSseEvent(response, state, 'response.content_part.done', {
          output_index: outputIndex,
          content_index: contentIndex,
          item_id: item.id,
          part,
        });
      });
      writeSseEvent(response, state, 'response.output_item.done', {
        output_index: outputIndex,
        item,
      });
      return;
    }

    if (item?.type === 'function_call') {
      const args = typeof item.arguments === 'string' ? item.arguments : JSON.stringify(item.arguments ?? {});
      writeSseEvent(response, state, 'response.output_item.added', {
        output_index: outputIndex,
        item: { ...item, status: 'in_progress', arguments: '' },
      });
      writeSseEvent(response, state, 'response.function_call_arguments.delta', {
        output_index: outputIndex,
        item_id: item.id,
        delta: args,
      });
      writeSseEvent(response, state, 'response.function_call_arguments.done', {
        output_index: outputIndex,
        item_id: item.id,
        arguments: args,
      });
      writeSseEvent(response, state, 'response.output_item.done', {
        output_index: outputIndex,
        item: { ...item, arguments: args },
      });
      return;
    }

    if (item?.type === 'custom_tool_call') {
      const input = typeof item.input === 'string' ? item.input : jsonText(item.input);
      writeSseEvent(response, state, 'response.output_item.added', {
        output_index: outputIndex,
        item: { ...item, status: 'in_progress', input: '' },
      });
      writeSseEvent(response, state, 'response.custom_tool_call_input.delta', {
        output_index: outputIndex,
        item_id: item.id,
        delta: input,
      });
      writeSseEvent(response, state, 'response.custom_tool_call_input.done', {
        output_index: outputIndex,
        item_id: item.id,
        input,
      });
      writeSseEvent(response, state, 'response.output_item.done', {
        output_index: outputIndex,
        item: { ...item, input },
      });
      return;
    }

    writeSseEvent(response, state, 'response.output_item.added', {
      output_index: outputIndex,
      item,
    });
    writeSseEvent(response, state, 'response.output_item.done', {
      output_index: outputIndex,
      item,
    });
  });

  writeSseEvent(response, state, 'response.completed', {
    response: { ...payload, status: 'completed', output },
  });
  response.write('data: [DONE]\n\n');
  response.end();
}

function jsonText(value) {
  if (typeof value === 'string') return value;
  if (value === null || value === undefined) return '';
  try {
    const serialized = JSON.stringify(value);
    return serialized === undefined ? String(value) : serialized;
  } catch {
    return String(value);
  }
}

function openAIContentToAnthropic(value) {
  const parts = Array.isArray(value) ? value : [value];
  const converted = [];
  for (const part of parts) {
    if (typeof part === 'string') {
      if (part) converted.push({ type: 'text', text: part });
      continue;
    }
    if (!part || typeof part !== 'object') continue;

    const type = part.type;
    if (['input_text', 'output_text', 'text', 'refusal'].includes(type)) {
      const text = typeof part.text === 'string' ? part.text : jsonText(part.value);
      if (text) converted.push({ type: 'text', text });
      continue;
    }

    if (type === 'input_image' || type === 'image_url') {
      const imageValue = part.image_url ?? part.image?.url ?? part.image;
      const imageUrl = typeof imageValue === 'string' ? imageValue : imageValue?.url;
      if (typeof imageUrl !== 'string' || imageUrl.length === 0) continue;
      const dataUrl = /^data:([^;,]+);base64,(.+)$/s.exec(imageUrl);
      converted.push(dataUrl
        ? { type: 'image', source: { type: 'base64', media_type: dataUrl[1], data: dataUrl[2] } }
        : { type: 'image', source: { type: 'url', url: imageUrl } });
      continue;
    }

    if (type === 'function_call' || type === 'custom_tool_call') {
      const argumentsValue = typeof part.arguments === 'string' ? part.arguments : jsonText(part.arguments || {});
      let input = {};
      if (type === 'custom_tool_call') input = { input: String(part.input || '') };
      else try { input = JSON.parse(argumentsValue); } catch { input = { arguments: argumentsValue }; }
      converted.push({
        type: 'tool_use',
        id: String(part.call_id || part.id || `call_${randomUUID()}`),
        name: String(part.name || part.function?.name || 'unknown_tool'),
        input,
      });
    }
  }
  return converted;
}

function appendAnthropicMessage(messages, role, content) {
  if (!Array.isArray(content) || content.length === 0) return;
  const previous = messages.at(-1);
  if (previous?.role === role) previous.content.push(...content);
  else messages.push({ role, content });
}

function appendSystemText(system, value) {
  const text = openAIContentToAnthropic(value)
    .filter((part) => part.type === 'text')
    .map((part) => part.text)
    .filter(Boolean);
  system.push(...text);
}

function toolResultText(value) {
  if (typeof value === 'string') return value;
  const text = openAIContentToAnthropic(value)
    .filter((part) => part.type === 'text')
    .map((part) => part.text)
    .join('\n');
  return text || jsonText(value);
}

function responsesInputToAnthropic(value) {
  const system = [];
  const messages = [];
  if (!value || typeof value !== 'object') return { system, messages };

  if (typeof value.instructions === 'string') system.push(value.instructions);
  if (value.system !== undefined) appendSystemText(system, value.system);

  const input = value.input;
  if (typeof input === 'string') {
    appendAnthropicMessage(messages, 'user', [{ type: 'text', text: input }]);
    return { system, messages };
  }
  if (!Array.isArray(input)) return { system, messages };

  for (const item of input) {
    if (typeof item === 'string') {
      appendAnthropicMessage(messages, 'user', [{ type: 'text', text: item }]);
      continue;
    }
    if (!item || typeof item !== 'object') continue;

    if (item.type === 'message') {
      const role = item.role === 'assistant' ? 'assistant' : item.role;
      if (role === 'system' || role === 'developer') appendSystemText(system, item.content);
      else if (role === 'user' || role === 'assistant') {
        appendAnthropicMessage(messages, role, openAIContentToAnthropic(item.content));
      }
      continue;
    }

    if (item.type === 'function_call_output' || item.type === 'custom_tool_call_output') {
      appendAnthropicMessage(messages, 'user', [{
        type: 'tool_result',
        tool_use_id: String(item.call_id || item.id || `call_${randomUUID()}`),
        content: toolResultText(item.output),
      }]);
      continue;
    }

    if (item.type === 'tool_search_output') {
      appendAnthropicMessage(messages, 'user', [{
        type: 'tool_result',
        tool_use_id: String(item.call_id || item.id || `call_${randomUUID()}`),
        content: jsonText({ tools: Array.isArray(item.tools) ? item.tools : [], status: item.status }),
      }]);
      continue;
    }

    if (item.type === 'function_call' || item.type === 'custom_tool_call') {
      const argumentsValue = typeof item.arguments === 'string' ? item.arguments : jsonText(item.arguments || {});
      let inputValue = {};
      if (item.type === 'custom_tool_call') inputValue = { input: String(item.input || '') };
      else try { inputValue = JSON.parse(argumentsValue); } catch { inputValue = { arguments: argumentsValue }; }
      appendAnthropicMessage(messages, 'assistant', [{
        type: 'tool_use',
        id: String(item.call_id || item.id || `call_${randomUUID()}`),
        name: String(item.name || 'unknown_tool'),
        input: inputValue,
      }]);
      continue;
    }

    if (item.type === 'tool_search_call') {
      appendAnthropicMessage(messages, 'assistant', [{
        type: 'tool_use',
        id: String(item.call_id || item.id || `call_${randomUUID()}`),
        name: 'tool_search',
        input: item.arguments && typeof item.arguments === 'object' ? item.arguments : {},
      }]);
      continue;
    }

    if (item.type === 'input_text') {
      appendAnthropicMessage(messages, 'user', [{ type: 'text', text: item.text || '' }]);
      continue;
    }
    if (item.type === 'output_text') {
      appendAnthropicMessage(messages, 'assistant', [{ type: 'text', text: item.text || '' }]);
      continue;
    }
    if (item.type === 'reasoning') {
      const { blocks: thinkingBlocks, cont } = decodeThinkingEnvelope(item.encrypted_content);
      if (cont) {
        // Continuation boundary from a previous turn: replay the exact structure the model saw.
        appendAnthropicMessage(messages, 'user', [{ type: 'text', text: claudeContinuationMarkers[cont] }]);
      }
      if (thinkingBlocks.length > 0) appendAnthropicMessage(messages, 'assistant', thinkingBlocks);
      continue;
    }
    if (item.type === 'item_reference') continue;

    if (item.content !== undefined) {
      appendAnthropicMessage(messages, 'user', openAIContentToAnthropic(item.content));
    }
  }
  return { system, messages };
}

function customToolDescription(tool) {
  const parts = [tool.description || 'Free-form tool.'];
  parts.push('This tool takes raw text, not JSON arguments. Call it with exactly one field, "input", whose value is the complete raw tool input as a single string.');
  const format = tool.format && typeof tool.format === 'object' ? tool.format : null;
  if (format?.type === 'grammar' && typeof format.definition === 'string') {
    parts.push(`The input must conform to this ${format.syntax || ''} grammar:\n${format.definition}`);
  }
  return parts.join('\n');
}

function responsesToolsToAnthropic(tools) {
  if (!Array.isArray(tools)) return [];
  const seen = new Set();
  const converted = [];
  const flattened = [];
  const visit = (tool, namespace) => {
    if (!tool || typeof tool !== 'object') return;
    if (tool.type === 'namespace' && Array.isArray(tool.tools) && typeof tool.name === 'string') {
      for (const child of tool.tools) visit(child, tool.name);
      return;
    }
    flattened.push(namespace && typeof tool.name === 'string'
      ? { ...tool, name: `${namespace}__${tool.name}` }
      : tool);
  };
  for (const tool of tools) visit(tool);
  for (const tool of flattened) {
    if (!tool || typeof tool !== 'object') continue;
    if (tool.type === 'tool_search') {
      if (seen.has('tool_search')) continue;
      seen.add('tool_search');
      converted.push({
        name: 'tool_search',
        description: typeof tool.description === 'string'
          ? tool.description
          : 'Search for additional tools to load for the next turn.',
        input_schema: tool.parameters && typeof tool.parameters === 'object'
          ? tool.parameters
          : {
              type: 'object',
              properties: {
                query: { type: 'string', description: 'Search query for tools to load.' },
                limit: { type: 'number', description: 'Maximum number of tools to return.' },
              },
              required: ['query'],
              additionalProperties: false,
            },
      });
      continue;
    }
    const candidate = tool.function && typeof tool.function === 'object' ? tool.function : tool;
    if (tool.type && tool.type !== 'function' && tool.type !== 'custom') continue;
    const name = typeof candidate.name === 'string' ? candidate.name : null;
    if (!name || seen.has(name)) continue;
    seen.add(name);
    const customTool = tool.type === 'custom';
    converted.push({
      name,
      description: customTool
        ? customToolDescription(candidate)
        : (typeof candidate.description === 'string' ? candidate.description : undefined),
      input_schema: customTool
        ? {
            type: 'object',
            properties: { input: { type: 'string', description: 'Complete raw input for the free-form tool.' } },
            required: ['input'],
            additionalProperties: false,
          }
        : candidate.parameters && typeof candidate.parameters === 'object'
        ? candidate.parameters
        : (candidate.input_schema && typeof candidate.input_schema === 'object'
          ? candidate.input_schema
          : { type: 'object', properties: {}, additionalProperties: false }),
    });
  }
  return converted;
}

function allResponseTools(value) {
  const additionalTools = Array.isArray(value?.input)
    ? value.input.flatMap((item) => item?.type === 'additional_tools' && Array.isArray(item.tools) ? item.tools : [])
    : [];
  const searchedTools = Array.isArray(value?.input)
    ? value.input.flatMap((item) => item?.type === 'tool_search_output' && Array.isArray(item.tools) ? item.tools : [])
    : [];
  return [...(Array.isArray(value?.tools) ? value.tools : []), ...additionalTools, ...searchedTools];
}

function namespaceToolAliases(tools) {
  const aliases = new Map();
  for (const tool of Array.isArray(tools) ? tools : []) {
    if (tool?.type !== 'namespace' || typeof tool.name !== 'string' || !Array.isArray(tool.tools)) continue;
    for (const child of tool.tools) {
      if (!child || typeof child.name !== 'string') continue;
      aliases.set(`${tool.name}__${child.name}`, {
        namespace: tool.name,
        name: child.name,
        kind: child.type === 'custom' ? 'custom' : 'function',
      });
    }
  }
  return aliases;
}

function responseToolChoiceToAnthropic(value, model) {
  if (!value || typeof value !== 'object') return undefined;
  if (model === 'claude-fable-5-1' && ['function', 'required'].includes(value.type)) {
    return { type: 'auto' };
  }
  if (value.type === 'function' && typeof value.name === 'string') return { type: 'tool', name: value.name };
  if (value.type === 'required') return { type: 'any' };
  if (value.type === 'none') return { type: 'none' };
  if (value.type === 'auto') return { type: 'auto' };
  return undefined;
}

function buildClaudeAnthropicRequest(value) {
  const model = canonicalClaudeModel(value?.model);
  if (!model) throw new Error('Unsupported Claude model alias');
  const { system, messages } = responsesInputToAnthropic(value);
  if (messages.length === 0) throw new Error('Claude request contains no messages');

  // Codex never sends max_output_tokens. Use the model's per-call ceiling; the engine continues past it.
  const requestedMaxTokens = Number(value.max_output_tokens ?? value.max_tokens);
  const modelCap = Math.min(claudeMaxOutputTokensCap, model.startsWith('claude-haiku-') ? 64_000 : 128_000);
  const maxTokens = Number.isFinite(requestedMaxTokens)
    ? Math.min(modelCap, Math.max(1, Math.floor(requestedMaxTokens)))
    : modelCap;
  const result = {
    model,
    max_tokens: maxTokens,
    messages,
    stream: true,
    cache_control: claudeCacheControl(),
  };
  // Breakpoints: last tool (tools prefix), last system block (system prefix), plus automatic on the newest message.
  result.system = [
    { ...claudeAgentIdentitySystemBlock, cache_control: undefined },
    ...system.map((text) => ({ type: 'text', text })),
  ];
  result.system[result.system.length - 1] = { ...result.system[result.system.length - 1], cache_control: claudeCacheControl() };
  result.system = result.system.map((block) => (block.cache_control ? block : { type: block.type, text: block.text }));

  const tools = responsesToolsToAnthropic(allResponseTools(value));
  if (tools.length > 0) {
    tools[tools.length - 1] = { ...tools[tools.length - 1], cache_control: claudeCacheControl() };
    result.tools = tools;
  }
  const toolChoice = responseToolChoiceToAnthropic(value.tool_choice, model);
  if (toolChoice) result.tool_choice = toolChoice;
  if (Number.isFinite(value.temperature)) result.temperature = value.temperature;
  if (Number.isFinite(value.top_p)) result.top_p = value.top_p;
  if (Array.isArray(value.stop)) result.stop_sequences = value.stop;
  if (value.metadata?.user_id && typeof value.metadata.user_id === 'string') {
    result.metadata = { user_id: value.metadata.user_id.slice(0, 256) };
  }
  if (!model.startsWith('claude-haiku-')) {
    if (value.thinking && typeof value.thinking === 'object') result.thinking = value.thinking;
    else if (value.reasoning?.effort && value.reasoning.effort !== 'none') {
      result.thinking = { type: 'adaptive' };
    }
  }
  const requestedEffort = value.reasoning?.effort;
  const effort = requestedEffort === 'xhigh' ? 'max' : requestedEffort;
  if (['low', 'medium', 'high', 'max'].includes(effort)) {
    result.output_config = { effort };
  }
  return result;
}

function customToolNames(tools) {
  return new Set((Array.isArray(tools) ? tools : [])
    .filter((tool) => tool?.type === 'custom' && typeof tool.name === 'string')
    .map((tool) => tool.name));
}

// ---------- Claude adapter: continuation-capable streaming engine ----------
// One Codex turn = one OpenAI Responses stream. Under the hood the adapter may issue several
// Anthropic Messages calls (segments): retries before any content, and continuations after the
// model hits its per-call output ceiling or the upstream drops mid-response. Codex sees one response.
const claudeMaxOutputTokensCap = Math.max(1, Number(process.env.CODEX_BIFROST_CLAUDE_MAX_OUTPUT_TOKENS || 128_000));
const claudeMaxContinuations = Math.max(0, Number(process.env.CODEX_BIFROST_CLAUDE_MAX_CONTINUATIONS || 16));
const claudeMaxAttempts = Math.max(1, Number(process.env.CODEX_BIFROST_CLAUDE_MAX_ATTEMPTS || 6));
const claudeCacheTtl = process.env.CODEX_BIFROST_CLAUDE_CACHE_TTL === '1h' ? '1h' : null;
const claudeContinuationMarkers = {
  limit: '[System: your previous message hit the output token limit mid-stream. Resume exactly where it stopped. Output only the remaining continuation: no preamble, no recap, do not repeat any text already sent.]',
  drop: '[System: the connection dropped mid-response. Resume exactly where you stopped. Output only the remaining continuation: no preamble, no recap, do not repeat what was already sent.]',
  toolcut: '[System: your tool call was cut off by the output limit before it completed and was discarded. Re-issue that tool call in full.]',
};
const thinkingEnvelopeVersion = 2;

function claudeCacheControl() {
  return claudeCacheTtl ? { type: 'ephemeral', ttl: claudeCacheTtl } : { type: 'ephemeral' };
}

function encodeThinkingEnvelope(blocks, cont = null) {
  const kept = (Array.isArray(blocks) ? blocks : [])
    .filter((block) => block && (block.type === 'thinking' || block.type === 'redacted_thinking'))
    .map((block) => (block.type === 'thinking'
      ? { type: 'thinking', thinking: String(block.thinking || ''), signature: String(block.signature || '') }
      : { type: 'redacted_thinking', data: String(block.data || '') }));
  const envelope = { v: thinkingEnvelopeVersion, blocks: kept };
  if (cont) envelope.cont = cont;
  return Buffer.from(JSON.stringify(envelope)).toString('base64');
}

function decodeThinkingEnvelope(encrypted) {
  if (typeof encrypted !== 'string' || encrypted.length === 0) return { blocks: [], cont: null };
  try {
    const parsed = JSON.parse(Buffer.from(encrypted, 'base64').toString('utf8'));
    if (![1, thinkingEnvelopeVersion].includes(parsed?.v) || !Array.isArray(parsed.blocks)) return { blocks: [], cont: null };
    const blocks = parsed.blocks.filter((block) => (
      (block?.type === 'thinking' && typeof block.signature === 'string' && block.signature.length > 0)
      || (block?.type === 'redacted_thinking' && typeof block.data === 'string')
    ));
    const cont = typeof parsed.cont === 'string' && claudeContinuationMarkers[parsed.cont] ? parsed.cont : null;
    return { blocks, cont };
  } catch {
    return { blocks: [], cont: null };
  }
}

// Anthropic reports uncached input separately; OpenAI's input_tokens includes cached reads.
// Codex sizes its context window from input_tokens, so it must see the full prompt size.
function openAIUsageFromAnthropic(usage) {
  const uncached = Number(usage?.input_tokens || 0);
  const cacheRead = Number(usage?.cache_read_input_tokens || 0);
  const cacheWrite = Number(usage?.cache_creation_input_tokens || 0);
  const outputTokens = Number(usage?.output_tokens || 0);
  const inputTokens = uncached + cacheRead + cacheWrite;
  return {
    input_tokens: inputTokens,
    input_tokens_details: { cached_tokens: cacheRead },
    output_tokens: outputTokens,
    output_tokens_details: { reasoning_tokens: 0 },
    total_tokens: inputTokens + outputTokens,
  };
}

function waitWithKeepalive(ms, keepalive) {
  return new Promise((resolve) => {
    const tick = setInterval(keepalive, 10_000);
    setTimeout(() => { clearInterval(tick); resolve(); }, ms);
  });
}

function retryDelayMs(attempt, retryAfterHeader) {
  const retryAfter = Number(retryAfterHeader);
  if (Number.isFinite(retryAfter) && retryAfter >= 0) return Math.min(retryAfter * 1_000, 60_000);
  const base = Math.min(30_000, 1_000 * 2 ** (attempt - 1));
  return base + Math.floor(Math.random() * 500);
}

// Emits OpenAI Responses SSE (or collects for non-stream) across any number of Anthropic segments.
function createResponsesEmitter(response, { streaming, requestedModel }) {
  const state = { sequence: 0 };
  const output = [];
  const responseId = `resp_${randomUUID().replaceAll('-', '')}`;
  const createdAt = Math.floor(Date.now() / 1_000);
  let nextIndex = 0;
  let finished = false;
  let aborted = false;
  const base = () => ({ id: responseId, object: 'response', created_at: createdAt, model: requestedModel || 'claude', output: [] });
  if (streaming) {
    response.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store',
      connection: 'keep-alive',
      'x-codex-bifrost-normalizer': '1',
      'x-codex-bifrost-live-stream': '1',
    });
    writeSseEvent(response, state, 'response.created', { response: { ...base(), status: 'in_progress' } });
    writeSseEvent(response, state, 'response.in_progress', { response: { ...base(), status: 'in_progress' } });
  }
  const emit = (type, value) => {
    if (streaming && !finished && !aborted) writeSseEvent(response, state, type, value);
  };
  const keepalive = () => {
    if (streaming && !finished && !aborted) response.write(': keepalive\n\n');
  };
  const finish = (status, usage, extra = {}) => {
    if (finished || aborted) return;
    finished = true;
    const finalOutput = output.filter(Boolean);
    const payload = {
      ...base(),
      status,
      output: finalOutput,
      output_text: finalOutput.filter((item) => item.type === 'message')
        .flatMap((item) => item.content || [])
        .filter((part) => part.type === 'output_text')
        .map((part) => part.text)
        .join(''),
      usage,
      incomplete_details: null,
      ...extra,
    };
    if (streaming) {
      writeSseEvent(response, state, status === 'failed' ? 'response.failed' : 'response.completed', { response: payload });
      response.write('data: [DONE]\n\n');
      response.end();
    } else if (status === 'failed') {
      sendJson(response, 502, { error: payload.error || { message: 'Claude adapter failed' }, response: payload });
    } else {
      sendJson(response, 200, payload, { 'x-codex-bifrost-normalizer': '1' });
    }
  };
  return {
    output,
    emit,
    keepalive,
    finish,
    newIndex: () => nextIndex++,
    hasContent: () => output.some((item) => item && item.type !== 'reasoning'),
    completeToolCalls: () => output.filter((item) => item && ['function_call', 'custom_tool_call', 'tool_search_call'].includes(item.type)).length,
    abort: () => { aborted = true; },
    isDone: () => finished || aborted,
    addReasoningItem(blocks, cont = null) {
      const outputIndex = nextIndex++;
      const summaryText = blocks.filter((block) => block?.type === 'thinking').map((block) => block.thinking || '').join('\n').trim();
      const item = {
        id: `rs_${randomUUID().replaceAll('-', '')}`,
        type: 'reasoning',
        status: 'completed',
        summary: summaryText ? [{ type: 'summary_text', text: summaryText }] : [],
        encrypted_content: encodeThinkingEnvelope(blocks, cont),
      };
      emit('response.output_item.added', { output_index: outputIndex, item: { ...item, status: 'in_progress' } });
      emit('response.output_item.done', { output_index: outputIndex, item });
      output[outputIndex] = item;
      return item;
    },
    addTextItem(text) {
      const outputIndex = nextIndex++;
      const part = { type: 'output_text', text, annotations: [], logprobs: [] };
      const item = { id: `msg_${randomUUID().replaceAll('-', '')}`, type: 'message', role: 'assistant', status: 'completed', content: [part] };
      emit('response.output_item.added', { output_index: outputIndex, item: { ...item, status: 'in_progress', content: [] } });
      emit('response.content_part.added', { output_index: outputIndex, content_index: 0, item_id: item.id, part: { ...part, text: '' } });
      emit('response.output_text.delta', { output_index: outputIndex, content_index: 0, item_id: item.id, delta: text, logprobs: [] });
      emit('response.output_text.done', { output_index: outputIndex, content_index: 0, item_id: item.id, text, logprobs: [] });
      emit('response.content_part.done', { output_index: outputIndex, content_index: 0, item_id: item.id, part });
      emit('response.output_item.done', { output_index: outputIndex, item });
      output[outputIndex] = item;
      return item;
    },
  };
}

function claudeUpstreamRequest(body, headers) {
  return new Promise((resolve, reject) => {
    const upstreamRequest = http.request({
      protocol: anthropicUpstream.protocol,
      hostname: anthropicUpstream.hostname,
      port: anthropicUpstream.port,
      method: 'POST',
      path: '/anthropic/v1/messages?beta=true',
      headers: { ...headers, 'content-length': String(body.length) },
    }, (upstreamResponse) => resolve(upstreamResponse));
    upstreamRequest.on('error', reject);
    upstreamRequest.end(body);
  });
}

function readAll(stream) {
  return new Promise((resolve) => {
    const chunks = [];
    stream.on('data', (chunk) => chunks.push(chunk));
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('error', () => resolve(Buffer.concat(chunks)));
  });
}

// Parse a 400 that says the request does not fit and return a max_tokens that does.
function fittedMaxTokens(message, currentMax) {
  if (typeof message !== 'string') return null;
  const window = /(\d+)\s*\+\s*(\d+)\s*>\s*(\d+)/.exec(message);
  if (window) {
    const limit = Number(window[3]);
    const input = Number(window[1]);
    const fitted = limit - input - 1_024;
    return fitted > 256 && fitted < currentMax ? fitted : null;
  }
  const cap = /max_tokens:\s*\d+\s*>\s*(\d+)/.exec(message);
  if (cap) {
    const fitted = Number(cap[1]);
    return fitted > 0 && fitted < currentMax ? fitted : null;
  }
  return null;
}

// Run one Anthropic segment: retries until content starts flowing, then translates the stream.
// Resolves to { kind: 'done'|'interrupted'|'error', stopReason, blocks, usage, status, error, attempts }.
async function runClaudeSegment({ requestBody, headersFor, emitter, requestedTools, taskLabel, isAborted, log }) {
  const customNames = customToolNames(requestedTools);
  const namespaceAliases = namespaceToolAliases(requestedTools);
  let attempt = 0;
  let fitAdjustments = 0;

  while (true) {
    attempt += 1;
    if (isAborted()) return { kind: 'error', error: { code: 'client_closed', message: 'client closed' }, attempts: attempt, blocks: [], status: 0 };
    let upstream;
    try {
      upstream = await claudeUpstreamRequest(Buffer.from(JSON.stringify(requestBody)), headersFor(attempt));
    } catch (error) {
      if (attempt < claudeMaxAttempts) {
        const delay = retryDelayMs(attempt);
        log({ event: 'claude_adapter_retry', reason: 'connect', attempt, delay_ms: delay, message: String(error?.message || error) });
        await waitWithKeepalive(delay, emitter.keepalive);
        continue;
      }
      return { kind: 'error', status: 502, error: { code: 'upstream_unavailable', message: `Bifrost/Anthropic unreachable: ${String(error?.message || error)}` }, attempts: attempt, blocks: [] };
    }
    const status = upstream.statusCode || 502;
    if (status >= 400) {
      const bodyText = (await readAll(upstream)).toString('utf8');
      let parsed = null;
      try { parsed = JSON.parse(bodyText); } catch { parsed = null; }
      const message = parsed?.error?.message || bodyText.slice(0, 400) || `HTTP ${status}`;
      const errorType = parsed?.error?.type || 'api_error';
      if (status === 400 && fitAdjustments < 2) {
        const fitted = fittedMaxTokens(message, requestBody.max_tokens);
        if (fitted) {
          fitAdjustments += 1;
          log({ event: 'claude_adapter_fit_max_tokens', from: requestBody.max_tokens, to: fitted, message: message.slice(0, 200) });
          requestBody.max_tokens = fitted;
          attempt -= 1;
          continue;
        }
      }
      const retryable = status === 429 || status === 529 || status === 500 || status === 502 || status === 503 || status === 504 || status === 408;
      if (retryable && attempt < claudeMaxAttempts) {
        const delay = retryDelayMs(attempt, upstream.headers['retry-after']);
        log({ event: 'claude_adapter_retry', reason: `http_${status}`, attempt, delay_ms: delay, message: message.slice(0, 200) });
        await waitWithKeepalive(delay, emitter.keepalive);
        continue;
      }
      return { kind: 'error', status, error: { code: errorType, message: `Anthropic ${status} after ${attempt} attempt(s): ${message}` }, attempts: attempt, blocks: [] };
    }

    // 2xx: translate the SSE stream live.
    const isEventStream = String(upstream.headers['content-type'] || '').includes('text/event-stream');
    if (!isEventStream) {
      const bodyText = (await readAll(upstream)).toString('utf8');
      let value;
      try { value = JSON.parse(bodyText); } catch {
        return { kind: 'error', status: 502, error: { code: 'bad_upstream', message: 'Anthropic returned non-JSON, non-stream body' }, attempts: attempt, blocks: [] };
      }
      const blocks = [];
      for (const block of Array.isArray(value.content) ? value.content : []) {
        blocks.push(emitAnthropicBlock(block, emitter, customNames, namespaceAliases));
      }
      return { kind: 'done', stopReason: value.stop_reason || 'end_turn', blocks, usage: openAIUsageFromAnthropic(value.usage), attempts: attempt, status };
    }

    const result = await translateAnthropicStream(upstream, { emitter, customNames, namespaceAliases, isAborted });
    result.attempts = attempt;
    result.status = status;
    if (result.kind === 'interrupted' && result.blocks.length === 0 && attempt < claudeMaxAttempts) {
      const delay = retryDelayMs(attempt);
      log({ event: 'claude_adapter_retry', reason: 'stream_dropped_before_content', attempt, delay_ms: delay, message: result.error?.message || '' });
      await waitWithKeepalive(delay, emitter.keepalive);
      continue;
    }
    return result;
  }
}

// Emit a completed Anthropic block (non-stream path) and return its record.
function emitAnthropicBlock(block, emitter, customNames, namespaceAliases) {
  if (block.type === 'thinking' || block.type === 'redacted_thinking') {
    emitter.addReasoningItem([block]);
    return { block, complete: true };
  }
  if (block.type === 'text') {
    emitter.addTextItem(block.text || '');
    return { block, complete: true };
  }
  if (block.type === 'tool_use') {
    const outputIndex = emitter.newIndex();
    const item = toolUseItem(block.id, block.name, jsonText(block.input || {}), block.input || {}, customNames, namespaceAliases);
    emitter.emit('response.output_item.added', { output_index: outputIndex, item: { ...item, status: 'in_progress' } });
    emitter.emit('response.output_item.done', { output_index: outputIndex, item });
    emitter.output[outputIndex] = item;
    return { block, complete: true };
  }
  return { block, complete: true };
}

function toolUseItem(callIdRaw, nameRaw, argsText, parsedInput, customNames, namespaceAliases) {
  const callId = String(callIdRaw || `call_${randomUUID()}`);
  const name = String(nameRaw || 'unknown_tool');
  if (name === 'tool_search') {
    return { id: `tsc_${randomUUID().replaceAll('-', '')}`, type: 'tool_search_call', status: 'completed', call_id: callId, execution: 'client', arguments: parsedInput && typeof parsedInput === 'object' ? parsedInput : {} };
  }
  const namespaceIdentity = namespaceAliases.get(name);
  const isCustom = customNames.has(name) || namespaceIdentity?.kind === 'custom';
  if (isCustom) {
    const input = parsedInput && typeof parsedInput.input === 'string' ? parsedInput.input : argsText;
    return { id: `ctc_${randomUUID().replaceAll('-', '')}`, type: 'custom_tool_call', status: 'completed', call_id: callId, name: namespaceIdentity?.name || name, ...(namespaceIdentity ? { namespace: namespaceIdentity.namespace } : {}), input };
  }
  return { id: `fc_${randomUUID().replaceAll('-', '')}`, type: 'function_call', status: 'completed', call_id: callId, name: namespaceIdentity?.name || name, ...(namespaceIdentity ? { namespace: namespaceIdentity.namespace } : {}), arguments: argsText };
}

// Translate one Anthropic SSE stream into Responses events. Returns the segment's blocks so the
// orchestrator can replay them for a continuation.
function translateAnthropicStream(upstream, { emitter, customNames, namespaceAliases, isAborted }) {
  return new Promise((resolve) => {
    const blocks = new Map(); // anthropic index -> live block state
    const segmentBlocks = []; // ordered { block, complete }
    let usage = openAIUsageFromAnthropic(null);
    let stopReason = null;
    let settled = false;
    let lastError = null;
    const settle = (kind, error) => {
      if (settled) return;
      settled = true;
      // Close out any block still open (stream dropped mid-block).
      for (const entry of blocks.values()) {
        if (!entry.closed) closeBlock(entry, false);
      }
      resolve({ kind, stopReason, blocks: segmentBlocks, usage, error: error || lastError });
    };

    const closeBlock = (entry, byServer) => {
      entry.closed = true;
      if (entry.kind === 'thinking' || entry.kind === 'redacted_thinking') {
        const block = entry.kind === 'thinking'
          ? { type: 'thinking', thinking: entry.thinking, signature: entry.signature }
          : { type: 'redacted_thinking', data: entry.data };
        const summary = entry.thinking.trim() ? [{ type: 'summary_text', text: entry.thinking }] : [];
        const item = { ...entry.item, status: 'completed', summary, encrypted_content: encodeThinkingEnvelope([block]) };
        if (entry.kind === 'thinking') {
          emitter.emit('response.reasoning_summary_text.done', { output_index: entry.outputIndex, item_id: item.id, summary_index: 0, text: entry.thinking });
          emitter.emit('response.reasoning_summary_part.done', { output_index: entry.outputIndex, item_id: item.id, summary_index: 0, part: { type: 'summary_text', text: entry.thinking } });
        }
        emitter.emit('response.output_item.done', { output_index: entry.outputIndex, item });
        emitter.output[entry.outputIndex] = item;
        // A thinking block without a signature cannot be replayed; keep it only if signed.
        const replayable = entry.kind === 'redacted_thinking' || entry.signature.length > 0;
        segmentBlocks.push({ block, complete: byServer && replayable, replayable });
        return;
      }
      if (entry.kind === 'text') {
        const part = { type: 'output_text', text: entry.text, annotations: [], logprobs: [] };
        const item = { ...entry.item, status: 'completed', content: [part] };
        emitter.emit('response.output_text.done', { output_index: entry.outputIndex, content_index: 0, item_id: item.id, text: entry.text, logprobs: [] });
        emitter.emit('response.content_part.done', { output_index: entry.outputIndex, content_index: 0, item_id: item.id, part });
        emitter.emit('response.output_item.done', { output_index: entry.outputIndex, item });
        emitter.output[entry.outputIndex] = item;
        segmentBlocks.push({ block: { type: 'text', text: entry.text }, complete: byServer, replayable: entry.text.length > 0 });
        return;
      }
      if (entry.kind === 'tool_use') {
        let parsed = null;
        try { parsed = entry.json ? JSON.parse(entry.json) : {}; } catch { parsed = null; }
        if (parsed === null || !byServer) {
          // Partial tool call: never hand Codex a broken call. Drop the placeholder slot.
          emitter.output[entry.outputIndex] = null;
          segmentBlocks.push({ block: { type: 'tool_use', id: entry.callId, name: entry.name, input: null }, complete: false, replayable: false, partialTool: true });
          return;
        }
        const item = toolUseItem(entry.callId, entry.name, entry.json || '{}', parsed, customNames, namespaceAliases);
        if (item.type === 'function_call') {
          emitter.emit('response.function_call_arguments.done', { output_index: entry.outputIndex, item_id: entry.item.id, arguments: item.arguments });
        } else if (item.type === 'custom_tool_call') {
          emitter.emit('response.custom_tool_call_input.done', { output_index: entry.outputIndex, item_id: entry.item.id, input: item.input });
        }
        emitter.emit('response.output_item.done', { output_index: entry.outputIndex, item: { ...item, id: entry.item.id } });
        emitter.output[entry.outputIndex] = { ...item, id: entry.item.id };
        segmentBlocks.push({ block: { type: 'tool_use', id: entry.callId, name: entry.name, input: parsed }, complete: true, replayable: true });
      }
    };

    const handleEvent = (eventType, value) => {
      if (eventType === 'message_start') {
        usage = openAIUsageFromAnthropic(value.message?.usage);
        return;
      }
      if (eventType === 'content_block_start') {
        const block = value.content_block || {};
        const outputIndex = emitter.newIndex();
        if (block.type === 'thinking' || block.type === 'redacted_thinking') {
          const item = { id: `rs_${randomUUID().replaceAll('-', '')}`, type: 'reasoning', status: 'in_progress', summary: [] };
          blocks.set(value.index, { kind: block.type, item, outputIndex, thinking: '', signature: '', data: block.data || '', closed: false });
          emitter.emit('response.output_item.added', { output_index: outputIndex, item });
          if (block.type === 'thinking') {
            emitter.emit('response.reasoning_summary_part.added', { output_index: outputIndex, item_id: item.id, summary_index: 0, part: { type: 'summary_text', text: '' } });
          }
          return;
        }
        if (block.type === 'text') {
          const item = { id: `msg_${randomUUID().replaceAll('-', '')}`, type: 'message', role: 'assistant', status: 'in_progress', content: [] };
          blocks.set(value.index, { kind: 'text', item, outputIndex, text: '', closed: false });
          emitter.emit('response.output_item.added', { output_index: outputIndex, item });
          emitter.emit('response.content_part.added', { output_index: outputIndex, content_index: 0, item_id: item.id, part: { type: 'output_text', text: '', annotations: [], logprobs: [] } });
          return;
        }
        if (block.type === 'tool_use') {
          const preview = toolUseItem(block.id, block.name, '', {}, customNames, namespaceAliases);
          const item = { ...preview, status: 'in_progress' };
          blocks.set(value.index, { kind: 'tool_use', item, outputIndex, callId: String(block.id || ''), name: String(block.name || 'unknown_tool'), json: '', closed: false });
          emitter.emit('response.output_item.added', { output_index: outputIndex, item });
          return;
        }
        blocks.set(value.index, { kind: 'unknown', item: null, outputIndex, closed: true });
        return;
      }
      if (eventType === 'content_block_delta') {
        const entry = blocks.get(value.index);
        if (!entry) return;
        const delta = value.delta || {};
        if (entry.kind === 'thinking' && delta.type === 'thinking_delta') {
          entry.thinking += delta.thinking || '';
          emitter.emit('response.reasoning_summary_text.delta', { output_index: entry.outputIndex, item_id: entry.item.id, summary_index: 0, delta: delta.thinking || '' });
        } else if (entry.kind === 'thinking' && delta.type === 'signature_delta') {
          entry.signature += delta.signature || '';
        } else if (entry.kind === 'text' && delta.type === 'text_delta') {
          entry.text += delta.text || '';
          emitter.emit('response.output_text.delta', { output_index: entry.outputIndex, content_index: 0, item_id: entry.item.id, delta: delta.text || '', logprobs: [] });
        } else if (entry.kind === 'tool_use' && delta.type === 'input_json_delta') {
          entry.json += delta.partial_json || '';
          if (entry.item.type === 'function_call') {
            emitter.emit('response.function_call_arguments.delta', { output_index: entry.outputIndex, item_id: entry.item.id, delta: delta.partial_json || '' });
          }
        }
        return;
      }
      if (eventType === 'content_block_stop') {
        const entry = blocks.get(value.index);
        if (entry && !entry.closed) closeBlock(entry, true);
        return;
      }
      if (eventType === 'message_delta') {
        stopReason = value.delta?.stop_reason || stopReason;
        if (value.usage) {
          const outputTokens = Number(value.usage.output_tokens || usage.output_tokens);
          usage = { ...usage, output_tokens: outputTokens, total_tokens: usage.input_tokens + outputTokens };
        }
        return;
      }
      if (eventType === 'message_stop') {
        settle('done');
        return;
      }
      if (eventType === 'error') {
        lastError = { code: value.error?.type || 'server_error', message: value.error?.message || 'Anthropic stream error' };
        settle('interrupted', lastError);
      }
    };

    let buffer = '';
    const decoder = new StringDecoder('utf8');
    upstream.on('data', (chunk) => {
      if (isAborted()) { upstream.destroy(); settle('interrupted', { code: 'client_closed', message: 'client closed' }); return; }
      buffer = (buffer + decoder.write(chunk)).replace(/\r\n/g, '\n');
      let separatorIndex = buffer.indexOf('\n\n');
      while (separatorIndex >= 0) {
        const frame = buffer.slice(0, separatorIndex);
        buffer = buffer.slice(separatorIndex + 2);
        separatorIndex = buffer.indexOf('\n\n');
        const lines = frame.split('\n');
        const eventName = lines.find((line) => line.startsWith('event: '))?.slice(7) || '';
        const dataLines = lines.filter((line) => line.startsWith('data: ')).map((line) => line.slice(6));
        if (dataLines.length === 0) continue;
        let value;
        try { value = JSON.parse(dataLines.join('\n')); } catch { continue; }
        try { handleEvent(value.type || eventName, value); } catch (error) {
          settle('interrupted', { code: 'normalizer_error', message: String(error?.message || error) });
        }
      }
    });
    upstream.on('end', () => settle(stopReason ? 'done' : 'interrupted', stopReason ? null : { code: 'upstream_closed', message: 'Anthropic stream ended before message_stop' }));
    upstream.on('error', (error) => settle('interrupted', { code: 'upstream_error', message: String(error?.message || error) }));
  });
}

async function proxyClaudeResponsesRequest(response, normalizedBody, taskLabel, startedAt) {
  let accessToken;
  let requestBody;
  try {
    accessToken = readClaudeOAuthAccessToken();
    requestBody = buildClaudeAnthropicRequest(normalizedBody);
  } catch (error) {
    sendJson(response, error.message.includes('OAuth') ? 401 : 400, {
      error: { type: error.message.includes('OAuth') ? 'authentication_error' : 'invalid_request_error', message: error.message },
    });
    return;
  }
  const streaming = normalizedBody.stream === true;
  requestBody.stream = true; // always stream upstream; the emitter decides what the client gets
  const requestedTools = allResponseTools(normalizedBody);
  const sessionId = typeof normalizedBody.prompt_cache_key === 'string' && /^[0-9a-f-]{36}$/i.test(normalizedBody.prompt_cache_key)
    ? normalizedBody.prompt_cache_key
    : randomUUID();
  const headersFor = (attempt) => ({
    authorization: `Bearer ${accessToken}`,
    accept: 'text/event-stream',
    'anthropic-beta': claudeOAuthBeta,
    'anthropic-dangerous-direct-browser-access': 'true',
    'anthropic-version': '2023-06-01',
    'x-app': 'cli',
    'x-claude-code-session-id': sessionId,
    'x-stainless-retry-count': String(attempt - 1),
    'user-agent': 'claude-cli/2.1.259 (external, cli)',
    'accept-encoding': 'identity',
    'content-type': 'application/json',
  });
  const log = (fields) => console.log(JSON.stringify({ task_label: taskLabel, model: normalizedBody.model || null, ...fields }));

  const emitter = createResponsesEmitter(response, { streaming, requestedModel: normalizedBody.model });
  let aborted = false;
  response.on('close', () => { if (!emitter.isDone()) { aborted = true; emitter.abort(); } });
  const isAborted = () => aborted;

  const segments = [];
  let continuations = 0;
  let totalOutputTokens = 0;
  let lastUsage = openAIUsageFromAnthropic(null);
  let contKind = null;

  const complete = (status, extra = {}) => {
    const usage = { ...lastUsage, output_tokens: totalOutputTokens, total_tokens: lastUsage.input_tokens + totalOutputTokens };
    emitter.finish(status, usage, extra);
    log({
      event: 'claude_adapter_complete',
      route: `normalizer:${listenPort}->bifrost:${anthropicUpstream.port}/anthropic`,
      status: segments.at(-1)?.status ?? null,
      segments: segments.length,
      continuations,
      attempts: segments.reduce((sum, segment) => sum + (segment.attempts || 0), 0),
      stream: streaming,
      response_status: status,
      stop_reason: segments.at(-1)?.stopReason ?? null,
      output_items: emitter.output.filter(Boolean).length,
      max_tokens: requestBody.max_tokens,
      usage,
      duration_ms: Date.now() - startedAt,
      ...(extra.error ? { error: extra.error } : {}),
    });
  };

  while (true) {
    if (contKind) emitter.addReasoningItem([], contKind);
    const segment = await runClaudeSegment({ requestBody, headersFor, emitter, requestedTools, taskLabel, isAborted, log });
    segments.push(segment);
    if (aborted) {
      log({ event: 'claude_adapter_complete', response_status: 'client_closed', segments: segments.length, duration_ms: Date.now() - startedAt });
      return;
    }
    if (segment.usage) {
      lastUsage = segment.usage;
      totalOutputTokens += Number(segment.usage.output_tokens || 0);
    }

    if (segment.kind === 'error') {
      if (emitter.hasContent()) {
        emitter.addTextItem(`\n\n[adapter: upstream failed after retries, reply may be incomplete: ${segment.error?.message || 'unknown error'}]`);
        complete('completed', { error: segment.error });
      } else {
        complete('failed', { error: segment.error });
      }
      return;
    }

    const blocks = segment.blocks;
    const completeToolCalls = blocks.filter((entry) => entry.block.type === 'tool_use' && entry.complete).length;
    const hitLimit = segment.stopReason === 'max_tokens';
    const interrupted = segment.kind === 'interrupted';

    if (!hitLimit && !interrupted) {
      complete('completed');
      return;
    }
    if (completeToolCalls > 0) {
      // The model already asked for tools; let Codex run them. Whatever was cut after them is dropped.
      complete('completed');
      return;
    }
    if (continuations >= claudeMaxContinuations) {
      emitter.addTextItem(`\n\n[adapter: stopped after ${continuations} continuations (${totalOutputTokens} output tokens); send "continue" to resume]`);
      complete('completed');
      return;
    }
    const replay = blocks.filter((entry) => entry.replayable).map((entry) => entry.block);
    const partialTool = blocks.some((entry) => entry.partialTool);
    if (partialTool && contKind === 'toolcut') {
      // The re-issued call was cut again: it cannot fit in the per-call ceiling, so retrying is pointless.
      emitter.addTextItem(`\n\n[adapter: a tool call exceeded the ${requestBody.max_tokens}-token output ceiling twice and was discarded; split the work into smaller calls]`);
      complete('completed');
      return;
    }
    if (replay.length === 0) {
      // Nothing usable to continue from: the model produced only a partial tool call or nothing.
      if (interrupted && segments.filter((s) => s.kind === 'interrupted').length >= claudeMaxAttempts) {
        complete(emitter.hasContent() ? 'completed' : 'failed', { error: segment.error });
        return;
      }
      contKind = partialTool ? 'toolcut' : (interrupted ? 'drop' : 'limit');
      continuations += 1;
      requestBody.messages = [...requestBody.messages, { role: 'user', content: [{ type: 'text', text: claudeContinuationMarkers[contKind] }] }];
      // An assistant message is required before a user message only if the last message is assistant; here the prior message is a user/tool_result so a bare marker is fine.
      log({ event: 'claude_adapter_continue', kind: contKind, continuation: continuations, replayed_blocks: 0 });
      continue;
    }
    contKind = partialTool ? 'toolcut' : (interrupted ? 'drop' : 'limit');
    continuations += 1;
    requestBody.messages = [
      ...requestBody.messages,
      { role: 'assistant', content: replay },
      { role: 'user', content: [{ type: 'text', text: claudeContinuationMarkers[contKind] }] },
    ];
    log({ event: 'claude_adapter_continue', kind: contKind, continuation: continuations, replayed_blocks: replay.length, output_tokens_so_far: totalOutputTokens });
  }
}

function proxyNativeOpenAIResponsesRequest(request, response, normalizedBody, taskLabel, startedAt) {
  const body = Buffer.from(JSON.stringify(normalizedBody));
  const headers = {
    ...request.headers,
    host: openAIUpstream.host,
    'accept-encoding': 'identity',
    'content-length': String(body.length),
  };
  delete headers['transfer-encoding'];
  const transport = openAIUpstream.protocol === 'https:' ? https : http;
  const upstreamRequest = transport.request({
    protocol: openAIUpstream.protocol,
    hostname: openAIUpstream.hostname,
    port: openAIUpstream.port || undefined,
    method: 'POST',
    path: '/backend-api/codex/responses',
    headers,
  }, (upstreamResponse) => {
    const responseHeaders = { ...upstreamResponse.headers, 'x-codex-bifrost-normalizer': '1' };
    delete responseHeaders['content-length'];
    delete responseHeaders['content-encoding'];
    delete responseHeaders['transfer-encoding'];
    response.writeHead(upstreamResponse.statusCode || 502, responseHeaders);
    upstreamResponse.pipe(response);
    upstreamResponse.on('end', () => {
      console.log(JSON.stringify({
        event: 'native_openai_complete',
        task_label: taskLabel,
        route: `normalizer:${listenPort}->${openAIUpstream.host}/backend-api/codex`,
        status: upstreamResponse.statusCode,
        model: normalizedBody.model || null,
        duration_ms: Date.now() - startedAt,
      }));
    });
  });
  upstreamRequest.on('error', (error) => {
    if (!response.headersSent) sendJson(response, 502, { error: { message: 'Native OpenAI upstream unavailable' } });
    else response.destroy(error);
  });
  upstreamRequest.end(body);
}

function proxyBufferedResponsesRequest(request, response, rawBody, parsedBody, taskLabel, startedAt) {
  const normalizedBody = {
    ...parsedBody,
    model: normalizeCodexModelAlias(parsedBody?.model),
  };
  const convertedAgentMessages = normalizeInterAgentInputItems(normalizedBody);
  if (convertedAgentMessages.length > 0) {
    console.log(JSON.stringify({
      event: 'normalized_inter_agent_input',
      task_label: taskLabel,
      converted: convertedAgentMessages.length,
      payloads: convertedAgentMessages,
    }));
  }
  const loadedToolGroups = Array.isArray(normalizedBody.input)
    ? normalizedBody.input
      .filter((item) => ['additional_tools', 'tool_search_output'].includes(item?.type) && Array.isArray(item.tools))
      .map((item) => item.tools.map((tool) => ({
        type: tool?.type || null,
        name: tool?.name || null,
        namespace: tool?.namespace || null,
        children: Array.isArray(tool?.tools) ? tool.tools.map((child) => child?.name || null) : [],
      })))
    : [];
  if (loadedToolGroups.length > 0) {
    console.log(JSON.stringify({ event: 'claude_loaded_tools', task_label: taskLabel, groups: loadedToolGroups }));
  }
  if (claudeAdapterEnabled && canonicalClaudeModel(normalizedBody?.model)) {
    proxyClaudeResponsesRequest(response, normalizedBody, taskLabel, startedAt);
    return;
  }
  if (isNativeOpenAIModel(normalizedBody?.model) && request.headers.authorization) {
    proxyNativeOpenAIResponsesRequest(request, response, normalizedBody, taskLabel, startedAt);
    return;
  }
  const synthesizeStream = normalizedBody?.stream === true;
  const upstreamBody = Buffer.from(JSON.stringify(synthesizeStream
    ? { ...normalizedBody, stream: false }
    : normalizedBody));
  const upstreamHeaders = {
    ...request.headers,
    host: upstream.host,
    'accept-encoding': 'identity',
    'content-length': String(upstreamBody.length),
  };
  delete upstreamHeaders['transfer-encoding'];

  const upstreamRequest = http.request({
    protocol: upstream.protocol,
    hostname: upstream.hostname,
    port: upstream.port,
    method: request.method,
    path: request.url,
    headers: upstreamHeaders,
  }, (upstreamResponse) => {
    const chunks = [];
    upstreamResponse.on('data', (chunk) => chunks.push(chunk));
    upstreamResponse.on('end', () => {
      const upstreamBuffer = Buffer.concat(chunks);
      if (!synthesizeStream || (upstreamResponse.statusCode || 500) >= 400) {
        const responseHeaders = { ...upstreamResponse.headers, 'x-codex-bifrost-normalizer': '1' };
        delete responseHeaders['transfer-encoding'];
        delete responseHeaders['content-encoding'];
        responseHeaders['content-length'] = String(upstreamBuffer.length);
        response.writeHead(upstreamResponse.statusCode || 502, responseHeaders);
        response.end(upstreamBuffer);
      } else {
        let payload;
        try {
          payload = JSON.parse(upstreamBuffer.toString('utf8'));
        } catch {
          sendJson(response, 502, { error: { message: 'Bifrost returned invalid buffered JSON' } });
          return;
        }
        writeSyntheticResponseStream(response, payload);
      }
      console.log(JSON.stringify({
        event: 'request_complete',
        task_label: taskLabel,
        route: `normalizer:${listenPort}->bifrost:${upstream.port}`,
        method: request.method,
        path: request.url,
        status: upstreamResponse.statusCode,
        stream: synthesizeStream,
        upstream_stream: false,
        synthetic_stream: synthesizeStream,
        model: synthesizeStream ? normalizedBody?.model || null : null,
        duration_ms: Date.now() - startedAt,
      }));
    });
  });

  upstreamRequest.on('error', () => {
    if (!response.headersSent) sendJson(response, 502, { error: { message: 'Bifrost upstream unavailable' } });
    else response.destroy();
  });
  upstreamRequest.end(upstreamBody.length > 0 ? upstreamBody : rawBody);
}

function createStreamState() {
  return {
    sequence: 0,
    reasoningIndexes: new Set(),
    reasoningItemIds: new Set(),
    outputIndexMap: new Map(),
    nextOutputIndex: 0,
    textByItem: new Map(),
    completedItems: new Map(),
    model: null,
    normalizedEvents: 0,
    droppedReasoningEvents: 0,
  };
}

function mappedOutputIndex(state, upstreamIndex) {
  if (!Number.isInteger(upstreamIndex)) return upstreamIndex;
  if (!state.outputIndexMap.has(upstreamIndex)) {
    state.outputIndexMap.set(upstreamIndex, state.nextOutputIndex++);
  }
  return state.outputIndexMap.get(upstreamIndex);
}

function normalizeFrame(frame, state) {
  const lines = frame.split('\n');
  const eventName = lines.find((line) => line.startsWith('event: '))?.slice(7) || '';
  const dataLines = lines.filter((line) => line.startsWith('data: ')).map((line) => line.slice(6));
  if (dataLines.length === 0 || dataLines[0] === '[DONE]') return `${frame}\n\n`;

  let value;
  try {
    value = JSON.parse(dataLines.join('\n'));
  } catch {
    return `${frame}\n\n`;
  }

  const eventType = value.type || eventName;
  const upstreamIndex = Number.isInteger(value.output_index) ? value.output_index : null;
  const itemId = value.item_id || value.item?.id || null;
  if (typeof value.response?.model === 'string' && value.response.model) state.model = value.response.model;

  if (eventType === 'response.output_item.added' && value.item?.type === 'reasoning') {
    if (upstreamIndex !== null) state.reasoningIndexes.add(upstreamIndex);
    if (itemId) state.reasoningItemIds.add(itemId);
    state.droppedReasoningEvents += 1;
    return '';
  }
  if (
    eventType.startsWith('response.reasoning_')
    || (upstreamIndex !== null && state.reasoningIndexes.has(upstreamIndex))
    || (itemId && state.reasoningItemIds.has(itemId))
    || value.item?.type === 'reasoning'
  ) {
    state.droppedReasoningEvents += 1;
    return '';
  }

  if (upstreamIndex !== null) value.output_index = mappedOutputIndex(state, upstreamIndex);
  if (
    Number.isInteger(value.content_index)
    && (eventType.startsWith('response.output_text.') || eventType.startsWith('response.content_part.'))
  ) {
    value.content_index = 0;
  }

  if (eventType === 'response.output_text.delta' && itemId) {
    state.textByItem.set(itemId, `${state.textByItem.get(itemId) || ''}${value.delta || ''}`);
  } else if (eventType === 'response.output_text.done' && itemId) {
    value.text = state.textByItem.get(itemId) || value.text || '';
  } else if (eventType === 'response.content_part.done' && itemId && value.part?.type === 'output_text') {
    value.part = { ...value.part, text: state.textByItem.get(itemId) || value.part.text || '' };
  } else if (eventType === 'response.output_item.done' && value.item?.type === 'message') {
    const completedText = state.textByItem.get(value.item.id) || '';
    value.item = {
      ...value.item,
      content: [{ type: 'output_text', text: completedText, annotations: [], logprobs: [] }],
    };
    state.completedItems.set(value.output_index, value.item);
  } else if (eventType === 'response.completed' && value.response) {
    value.response = {
      ...value.response,
      output: [...state.completedItems.entries()].sort(([left], [right]) => left - right).map(([, item]) => item),
    };
  }

  if (Number.isInteger(value.sequence_number)) value.sequence_number = state.sequence++;
  state.normalizedEvents += 1;
  return `event: ${eventType}\ndata: ${JSON.stringify(value)}\n\n`;
}

const server = http.createServer((request, response) => {
  if (request.method === 'GET' && request.url === '/health') {
    sendJson(response, 200, { status: 'ok', upstream: upstream.origin });
    return;
  }

  const startedAt = Date.now();
  const taskLabel = String(request.headers['x-codex-task-label'] || 'unlabeled').slice(0, 64);

  if (request.method === 'POST' && request.url?.startsWith('/openai/v1/responses')) {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      const rawBody = Buffer.concat(chunks);
      let parsedBody;
      try {
        parsedBody = JSON.parse(rawBody.toString('utf8'));
      } catch {
        sendJson(response, 400, { error: { message: 'Invalid JSON request body' } });
        return;
      }
      proxyBufferedResponsesRequest(request, response, rawBody, parsedBody, taskLabel, startedAt);
    });
    return;
  }

  const upstreamHeaders = { ...request.headers, host: upstream.host, 'accept-encoding': 'identity' };
  const upstreamRequest = http.request({
    protocol: upstream.protocol,
    hostname: upstream.hostname,
    port: upstream.port,
    method: request.method,
    path: request.url,
    headers: upstreamHeaders,
  }, (upstreamResponse) => {
    const responseHeaders = { ...upstreamResponse.headers, 'x-codex-bifrost-normalizer': '1' };
    delete responseHeaders['content-length'];
    delete responseHeaders['content-encoding'];
    delete responseHeaders['transfer-encoding'];
    response.writeHead(upstreamResponse.statusCode || 502, responseHeaders);

    const isEventStream = String(upstreamResponse.headers['content-type'] || '').includes('text/event-stream');
    if (!isEventStream) {
      upstreamResponse.pipe(response);
      upstreamResponse.on('end', () => {
        console.log(JSON.stringify({ event: 'request_complete', task_label: taskLabel, route: `normalizer:${listenPort}->bifrost:${upstream.port}`, method: request.method, path: request.url, status: upstreamResponse.statusCode, stream: false, model: null, duration_ms: Date.now() - startedAt }));
      });
      return;
    }

    const state = createStreamState();
    let buffer = '';
    upstreamResponse.on('data', (chunk) => {
      buffer += chunk.toString('utf8').replace(/\r\n/g, '\n');
      let separatorIndex = buffer.indexOf('\n\n');
      while (separatorIndex >= 0) {
        const frame = buffer.slice(0, separatorIndex);
        buffer = buffer.slice(separatorIndex + 2);
        response.write(normalizeFrame(frame, state));
        separatorIndex = buffer.indexOf('\n\n');
      }
    });
    upstreamResponse.on('end', () => {
      if (buffer.trim()) response.write(normalizeFrame(buffer, state));
      response.end();
      console.log(JSON.stringify({ event: 'request_complete', task_label: taskLabel, route: `normalizer:${listenPort}->bifrost:${upstream.port}`, method: request.method, path: request.url, status: upstreamResponse.statusCode, stream: true, model: state.model, normalized_events: state.normalizedEvents, dropped_reasoning_events: state.droppedReasoningEvents, duration_ms: Date.now() - startedAt }));
    });
    upstreamResponse.on('error', (error) => {
      if (!response.headersSent) sendJson(response, 502, { error: { message: 'Bifrost response stream failed' } });
      else response.destroy(error);
    });
  });

  upstreamRequest.on('error', () => {
    if (!response.headersSent) sendJson(response, 502, { error: { message: 'Bifrost upstream unavailable' } });
    else response.destroy();
  });
  request.pipe(upstreamRequest);
});

server.listen(listenPort, listenHost, () => {
  console.log(JSON.stringify({ event: 'listening', host: listenHost, port: listenPort, upstream: upstream.origin }));
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
