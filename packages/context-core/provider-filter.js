import { filterContextMessages, messageText } from "./filter.js";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
function itemType(item) {
    if (!item || typeof item !== "object")
        return "unknown";
    const record = item;
    return String(record.type ?? record.role ?? "unknown");
}
export function estimateProviderPayloadMetrics(payload) {
    const raw = (() => { try {
        return JSON.stringify(payload);
    }
    catch {
        return String(payload);
    } })();
    const record = payload && typeof payload === "object" ? payload : {};
    const input = Array.isArray(record.input) ? record.input : [];
    const messages = Array.isArray(record.messages) ? record.messages : [];
    const itemCounts = {};
    const itemChars = {};
    let functionCallOutputs = 0;
    let functionCallOutputChars = 0;
    let largeFunctionCallOutputs = 0;
    for (const item of [...input, ...messages]) {
        const type = itemType(item);
        const itemRaw = (() => { try {
            return JSON.stringify(item);
        }
        catch {
            return String(item);
        } })();
        itemCounts[type] = (itemCounts[type] ?? 0) + 1;
        itemChars[type] = (itemChars[type] ?? 0) + itemRaw.length;
        if (type === "function_call_output") {
            functionCallOutputs += 1;
            functionCallOutputChars += itemRaw.length;
            if (itemRaw.length > 4000)
                largeFunctionCallOutputs += 1;
        }
    }
    return {
        rawChars: raw.length,
        estimatedTokensByChars: Math.ceil(raw.length / 4),
        inputItems: input.length,
        messageItems: messages.length,
        functionCallOutputs,
        functionCallOutputChars,
        largeFunctionCallOutputs,
        containsFilteredTombstone: raw.includes("SISO_CONTEXT_FILTERED"),
        itemCounts,
        itemChars,
    };
}
export function filterProviderPayload(payload, options) {
    const before = estimateProviderPayloadMetrics(payload);
    if (!payload || typeof payload !== "object")
        return { payload, replacements: [], estimatedSavedTokens: 0, before, after: before };
    const record = payload;
    const fields = ["input", "messages"].filter((field) => Array.isArray(record[field]));
    if (!fields.length)
        return { payload, replacements: [], estimatedSavedTokens: 0, before, after: before };
    const nextPayload = { ...record };
    const toolSlim = slimProviderTools(record, options);
    if (toolSlim.applied)
        nextPayload.tools = toolSlim.tools;
    const replacements = [];
    const promptSlim = [];
    let estimatedSavedTokens = 0;
    let changed = toolSlim.applied;
    for (const field of fields) {
        const result = filterContextMessages(record[field], { runId: options.runId, protectLast: 8 });
        const slim = slimProviderHistory(result.messages, field, { runId: options.runId });
        if (result.replacements.length > 0 || slim.applied) {
            changed = true;
            nextPayload[field] = slim.messages;
        }
        replacements.push(...result.replacements.map((replacement) => ({ ...replacement, field })));
        estimatedSavedTokens += result.estimatedSavedTokens + (slim.estimatedSavedTokens ?? 0);
        if (slim.applied)
            promptSlim.push({ field, ...slim, messages: undefined });
    }
    if (!changed)
        return { payload, replacements: [], estimatedSavedTokens: 0, before, after: before };
    const after = estimateProviderPayloadMetrics(nextPayload);
    return {
        payload: nextPayload,
        replacements,
        estimatedSavedTokens,
        before,
        after,
        ...(promptSlim.length ? { promptSlim: promptSlim.length === 1 ? { ...promptSlim[0], beforeChars: before.rawChars, afterChars: after.rawChars } : promptSlim.map((item) => ({ ...item, beforeChars: before.rawChars, afterChars: after.rawChars })) } : {}),
        ...(toolSlim.applied ? { toolSlim: { ...toolSlim, tools: undefined } } : {}),
    };
}
function slimProviderTools(record, options) {
    const tools = Array.isArray(record.tools) ? record.tools : undefined;
    if (!tools || process.env.SISO_TOOL_SCHEMA_LAZY === "0")
        return { applied: false, tools };
    const threshold = Number(process.env.SISO_TOOL_SCHEMA_LAZY_THRESHOLD ?? 8);
    if (tools.length <= threshold)
        return { applied: false, tools };
    const root = options.cwd || process.cwd();
    const loaded = readLoadedToolState(root);
    const keepNames = new Set(["siso", "siso_context", "multi_tool_use", "imagegen", ...loaded.toolNames]);
    const kept = [];
    const hidden = [];
    for (const tool of tools) {
        const name = toolName(tool);
        if (!name || keepNames.has(name) || loaded.toolNames.some((n) => name.includes(n)))
            kept.push(tool);
        else
            hidden.push(name);
    }
    if (!hidden.length)
        return { applied: false, tools };
    const summaryTool = discoveryHintTool(kept[0] ?? tools[0], hidden.length, loaded.packIds);
    const nextTools = [...kept, summaryTool];
    const beforeChars = JSON.stringify(tools).length;
    const afterChars = JSON.stringify(nextTools).length;
    return {
        applied: true,
        tools: nextTools,
        originalToolCount: tools.length,
        keptToolCount: kept.length,
        hiddenToolCount: hidden.length,
        loadedPackIds: loaded.packIds,
        loadedToolIds: loaded.toolIds,
        estimatedSavedTokens: Math.max(0, Math.ceil((beforeChars - afterChars) / 4)),
    };
}
function discoveryHintTool(referenceTool, hiddenCount, loadedPackIds) {
    const description = `SISO lazy tool schema active: ${hiddenCount} tool schemas hidden from prompt. Use siso action=tool op=recommend/search/show/load to discover scenario cards and load relevant packs. Loaded packs: ${loadedPackIds.join(",") || "none"}.`;
    const emptySchema = { type: "object", properties: {}, additionalProperties: false };
    if (referenceTool && typeof referenceTool === "object" && referenceTool.function && typeof referenceTool.function === "object") {
        return {
            type: "function",
            function: {
                name: "siso_tool_discovery_hint",
                description,
                parameters: emptySchema,
            },
        };
    }
    if (referenceTool && typeof referenceTool === "object" && "input_schema" in referenceTool) {
        return {
            name: "siso_tool_discovery_hint",
            description,
            input_schema: emptySchema,
        };
    }
    return {
        type: "function",
        name: "siso_tool_discovery_hint",
        description,
        parameters: emptySchema,
    };
}
function toolName(tool) {
    if (!tool || typeof tool !== "object")
        return "";
    const record = tool;
    return String(record.name ?? record.function?.name ?? record.id ?? "");
}
function readLoadedToolState(root) {
    const statePath = path.join(root, ".siso", "tool-state.json");
    if (!existsSync(statePath))
        return { toolIds: [], packIds: [], toolNames: [] };
    try {
        const state = JSON.parse(readFileSync(statePath, "utf8"));
        const toolIds = Array.isArray(state.toolIds) ? state.toolIds : [];
        const packIds = Array.isArray(state.packIds) ? state.packIds : [];
        return { toolIds, packIds, toolNames: toolIds.map((id) => id.replace(/-([a-z])/g, (_, c) => c.toUpperCase())) };
    }
    catch {
        return { toolIds: [], packIds: [], toolNames: [] };
    }
}
function envFlag(name, fallback = true) {
    const value = process.env[name];
    if (value === undefined)
        return fallback;
    return !/^(0|false|off|no)$/i.test(value);
}
function envInt(name, fallback) {
    const parsed = Number.parseInt(process.env[name] ?? "", 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
function rawChars(value) {
    try {
        return JSON.stringify(value).length;
    }
    catch {
        return String(value).length;
    }
}
function roleOf(item) {
    return item && typeof item === "object" && typeof item.role === "string" ? item.role : "";
}
function textFromItem(item) {
    const text = messageText(item);
    if (text)
        return text;
    try {
        return JSON.stringify(item);
    }
    catch {
        return String(item ?? "");
    }
}
function isToolResultMessage(item) {
    if (!item || typeof item !== "object")
        return false;
    const role = roleOf(item);
    if (role === "tool" || role === "toolResult" || role === "tool_result")
        return true;
    if (item.type === "function_call_output")
        return true;
    return Array.isArray(item.content) && item.content.some((part) => part && typeof part === "object" && (part.type === "tool_result" || part.type === "function_call_output"));
}
function isAssistantToolUse(item) {
    if (!item || typeof item !== "object")
        return false;
    if (item.type === "function_call")
        return true;
    return roleOf(item) === "assistant" && Array.isArray(item.content) && item.content.some((part) => part && typeof part === "object" && (part.type === "tool_use" || part.type === "function_call"));
}
function safeTailStart(messages, requestedStart) {
    let start = Math.max(0, requestedStart);
    while (start > 0 && isToolResultMessage(messages[start]) && isAssistantToolUse(messages[start - 1]))
        start -= 1;
    return start;
}
function compactLine(text, limit = 240) {
    const compact = String(text ?? "").replace(/\s+/g, " ").trim();
    return compact.length > limit ? `${compact.slice(0, limit - 3)}...` : compact;
}
function summarizePrefix(prefix, options = {}) {
    const maxChars = envInt("SISO_PROMPT_SLIM_SUMMARY_MAX_CHARS", 6000);
    const toolResults = prefix.filter(isToolResultMessage).length;
    const assistantToolUses = prefix.filter(isAssistantToolUse).length;
    const filtered = prefix.filter((item) => textFromItem(item).includes("SISO_CONTEXT_FILTERED")).length;
    const meaningful = prefix
        .map((item, index) => ({ index, role: roleOf(item) || itemType(item), text: textFromItem(item), chars: rawChars(item) }))
        .filter((item) => item.text.trim())
        .slice(-24);
    const lines = [
        "[SISO_PROMPT_SLIM]",
        `run_id=${options.runId ?? "unknown"}`,
        `compressed_messages=${prefix.length}`,
        `compressed_chars=${prefix.reduce((sum, item) => sum + rawChars(item), 0)}`,
        `tool_results=${toolResults}`,
        `assistant_tool_uses=${assistantToolUses}`,
        `filtered_tombstones=${filtered}`,
        "Older conversation history was compacted before provider send to avoid replaying the whole session every turn.",
        "Preserve decisions, user intent, files touched, commands run, and open issues from these compact notes. Raw transcript remains in local SISO/Pi logs if exact text is needed.",
        "",
        "Compressed recent prefix notes:",
        ...meaningful.map((item) => `- #${item.index} ${item.role} ${item.chars}c: ${compactLine(item.text)}`),
        "[/SISO_PROMPT_SLIM]",
    ];
    const summary = lines.join("\n");
    return summary.length > maxChars ? `${summary.slice(0, maxChars - 80)}\n... [prompt slim summary truncated]\n[/SISO_PROMPT_SLIM]` : summary;
}
function summaryMessage(field, text) {
    if (field === "input") {
        return { role: "user", content: [{ type: "input_text", text }] };
    }
    return { role: "user", content: [{ type: "text", text }] };
}
function slimProviderHistory(messages, field, options = {}) {
    if (!envFlag("SISO_PROMPT_SLIM", true))
        return { applied: false, messages };
    const maxMessages = envInt("SISO_PROMPT_SLIM_MAX_MESSAGES", 96);
    const maxChars = envInt("SISO_PROMPT_SLIM_MAX_CHARS", 120_000);
    const keepLast = envInt("SISO_PROMPT_SLIM_KEEP_LAST", 32);
    const beforeChars = messages.reduce((sum, item) => sum + rawChars(item), 0);
    if (messages.length <= maxMessages && beforeChars <= maxChars)
        return { applied: false, messages };
    const requestedStart = Math.max(0, messages.length - keepLast);
    const tailStart = safeTailStart(messages, requestedStart);
    if (tailStart <= 1)
        return { applied: false, messages };
    const prefix = messages.slice(0, tailStart);
    const tail = messages.slice(tailStart);
    const summary = summaryMessage(field, summarizePrefix(prefix, options));
    const next = [summary, ...tail];
    const afterChars = next.reduce((sum, item) => sum + rawChars(item), 0);
    return {
        applied: true,
        messages: next,
        originalMessageCount: messages.length,
        keptMessageCount: tail.length,
        compressedMessageCount: prefix.length,
        originalChars: beforeChars,
        compactChars: afterChars,
        estimatedSavedTokens: Math.max(0, Math.ceil((beforeChars - afterChars) / 4)),
    };
}
