import { createHash } from "node:crypto";
const STATE_QUERY_RE = /\b(git status|pwd|ls\b|find\b|rg\b|grep\b|tree\b|git diff --stat|git branch)\b/i;
const NOISY_OUTPUT_RE = /(node_modules\/|\.jsonl:|"type":"session"|"type":"message"|"type":"message_start"|message_update|toolcall_delta|\.d\.ts\.map|\.js\.map|\/\.git\/)/i;
function isRecord(value) {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
function textFromContent(content) {
    if (typeof content === "string")
        return content;
    if (Array.isArray(content)) {
        return content.map((part) => {
            if (typeof part === "string")
                return part;
            if (isRecord(part) && typeof part.text === "string")
                return part.text;
            if (isRecord(part) && typeof part.content === "string")
                return part.content;
            return "";
        }).filter(Boolean).join("\n");
    }
    if (isRecord(content) && typeof content.text === "string")
        return content.text;
    return "";
}
function textFromOutput(output) {
    return textFromContent(output);
}
export function messageText(message) {
    if (!isRecord(message))
        return "";
    return textFromContent(message.content)
        || textFromOutput(message.output)
        || textFromContent(message.result)
        || textFromContent(message.text)
        || textFromContent(message.message);
}
function roleOf(message) {
    return isRecord(message) && typeof message.role === "string" ? message.role : "";
}
function toolCallIdOf(message) {
    if (!isRecord(message))
        return undefined;
    return typeof message.toolCallId === "string" ? message.toolCallId
        : typeof message.tool_call_id === "string" ? message.tool_call_id
            : Array.isArray(message.content) ? nestedToolCallIdOf(message.content)
                : typeof message.id === "string" ? message.id
                    : undefined;
}
function nestedToolCallIdOf(content) {
    for (const part of content) {
        if (!isRecord(part))
            continue;
        const id = typeof part.tool_use_id === "string" ? part.tool_use_id
            : typeof part.toolCallId === "string" ? part.toolCallId
                : typeof part.tool_call_id === "string" ? part.tool_call_id
                    : typeof part.id === "string" ? part.id
                        : undefined;
        if (id)
            return id;
    }
    return undefined;
}
function isToolResult(message) {
    if (!isRecord(message))
        return false;
    const role = roleOf(message);
    if (role === "toolResult" || role === "tool_result" || role === "tool")
        return true;
    if (message.type === "function_call_output")
        return true;
    if (Array.isArray(message.content) && message.content.some((part) => isRecord(part) && (part.type === "tool_result" || part.type === "function_call_output")))
        return true;
    return ("toolCallId" in message || "tool_call_id" in message) && ("result" in message || "content" in message || "output" in message);
}
function fingerprint(text) {
    return createHash("sha1").update(text.replace(/\s+/g, " ").trim().slice(0, 4000)).digest("hex");
}
function estimateTokens(text) {
    return Math.ceil(text.length / 4);
}
function compactSummary(text, limit = 900) {
    const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    const head = lines.slice(0, 8).join("\n");
    const tail = lines.length > 12 ? lines.slice(-4).join("\n") : "";
    const summary = tail ? `${head}\n…\n${tail}` : head || text.slice(0, limit);
    return summary.slice(0, limit);
}
function tombstone(replacement) {
    return [
        `[SISO_CONTEXT_FILTERED reason=${replacement.reason} original_chars=${replacement.originalChars} estimated_tokens=${replacement.estimatedTokens}]`,
        `Summary: Raw tool output was compacted before provider send to avoid replaying bulky or sensitive payloads.`,
        `Full raw output is preserved locally. Retrieve with: ${replacement.pointer}`,
    ].join("\n");
}
function replaceTextParts(parts, text) {
    let replaced = false;
    return parts.map((part) => {
        const nextText = replaced ? "[SISO_CONTEXT_FILTERED_CONTINUATION]" : text;
        if (typeof part === "string") {
            replaced = true;
            return nextText;
        }
        if (isRecord(part) && typeof part.text === "string") {
            replaced = true;
            return { ...part, text: nextText };
        }
        if (isRecord(part) && typeof part.content === "string") {
            replaced = true;
            return { ...part, content: nextText };
        }
        return part;
    });
}
function replaceMessageContent(message, text) {
    if (!isRecord(message))
        return message;
    const copy = { ...message };
    if (typeof copy.content === "string")
        copy.content = text;
    else if (Array.isArray(copy.content))
        copy.content = replaceTextParts(copy.content, text);
    else if (typeof copy.output === "string")
        copy.output = text;
    else if (Array.isArray(copy.output))
        copy.output = replaceTextParts(copy.output, text);
    else if (typeof copy.result === "string")
        copy.result = text;
    else if (typeof copy.text === "string")
        copy.text = text;
    else
        copy.content = text;
    return copy;
}
export function filterContextMessages(messages, options = { runId: "unknown" }) {
    const largeOutputTokens = options.largeOutputTokens ?? 1000;
    const protectLast = options.protectLast ?? 8;
    const replacements = [];
    const latestByHash = new Map();
    const latestByState = new Map();
    messages.forEach((message, index) => {
        if (!isToolResult(message))
            return;
        const text = messageText(message);
        if (!text)
            return;
        latestByHash.set(fingerprint(text), index);
        const state = text.match(STATE_QUERY_RE)?.[0]?.toLowerCase();
        if (state)
            latestByState.set(state, index);
    });
    const protectedStart = Math.max(0, messages.length - protectLast);
    const forceOldToolAfter = Math.max(0, Number.parseInt(process.env.SISO_CONTEXT_FORCE_OLD_TOOL_AFTER ?? "24", 10));
    const next = messages.map((message, index) => {
        if (!isToolResult(message))
            return message;
        const text = messageText(message);
        if (!text)
            return message;
        const tokens = estimateTokens(text);
        const hashLatest = latestByHash.get(fingerprint(text));
        const stateKey = text.match(STATE_QUERY_RE)?.[0]?.toLowerCase();
        const stateLatest = stateKey ? latestByState.get(stateKey) : undefined;
        const isProtected = index >= protectedStart;
        let reason;
        if (NOISY_OUTPUT_RE.test(text))
            reason = "noisy_tool_result";
        else if (tokens >= largeOutputTokens)
            reason = "large_tool_result";
        else if (forceOldToolAfter > 0 && index < messages.length - forceOldToolAfter && tokens >= 120)
            reason = "old_tool_result";
        else if (!isProtected && hashLatest !== undefined && hashLatest !== index)
            reason = "duplicate_tool_result";
        else if (!isProtected && stateLatest !== undefined && stateLatest !== index)
            reason = "state_query_result";
        if (!reason)
            return message;
        const toolCallId = toolCallIdOf(message);
        const pointer = `siso_context op=retrieve runId=${options.runId} eventId=${toolCallId ?? `context-message-${index}`}`;
        const replacement = { index, ...(toolCallId ? { toolCallId } : {}), reason, originalChars: text.length, estimatedTokens: tokens, pointer };
        replacements.push(replacement);
        return replaceMessageContent(message, tombstone(replacement));
    });
    return {
        messages: next,
        replacements,
        estimatedSavedTokens: replacements.reduce((sum, item) => sum + item.estimatedTokens, 0),
    };
}
