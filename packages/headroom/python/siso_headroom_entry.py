"""Fail-closed Headroom entrypoint for the SISO lossless pilot.

Headroom 0.32.0 deterministically reorders tool definitions and always strips
JSON-Schema annotations. Both operations can change a provider cache prefix or
model-visible tool guidance even when ``--lossless`` is selected. The SISO
pilot only authorizes tool-result text compaction, so this entrypoint disables
those two transforms before starting the upstream CLI.
"""

from __future__ import annotations

import importlib.metadata
import json
import sys
from typing import Any


EXPECTED_HEADROOM_VERSION = "0.32.0"


def _preserve_tools(
    _cls: type[Any], tools: list[dict[str, Any]] | None
) -> list[dict[str, Any]] | None:
    return tools


def _preserve_tool_schemas(
    payload: dict[str, Any],
) -> tuple[dict[str, Any], bool, int, int]:
    tools = payload.get("tools")
    before = (
        len(json.dumps(tools, ensure_ascii=False, default=str, separators=(",", ":")))
        if isinstance(tools, list)
        else 0
    )
    return payload, False, before, before


def _preserve_list_form_tool_results(
    original: Any,
    router: Any,
    message: dict[str, Any],
    content_blocks: list[Any],
    *args: Any,
    **kwargs: Any,
) -> dict[str, Any]:
    # Headroom 0.32.0 flattens a list of text blocks and rebuilds one new text
    # block, losing per-block metadata and boundaries. Leave the whole message
    # untouched when that shape appears; string-form tool results still use the
    # audited lossless compactor.
    for block in content_blocks:
        if not isinstance(block, dict) or block.get("type") != "tool_result":
            continue
        result_content = block.get("content")
        if (
            isinstance(result_content, list)
            and bool(result_content)
            and all(
                isinstance(item, dict) and item.get("type") == "text"
                for item in result_content
            )
        ):
            return message
    return original(router, message, content_blocks, *args, **kwargs)


def install_siso_safety_patch() -> None:
    installed = importlib.metadata.version("headroom-ai")
    if installed != EXPECTED_HEADROOM_VERSION:
        raise SystemExit(
            "siso-headroom: unsupported Headroom version "
            f"{installed!r}; audited version is {EXPECTED_HEADROOM_VERSION!r}"
        )

    from headroom.proxy import tool_schema_compaction
    from headroom.proxy.handlers.anthropic import AnthropicHandlerMixin
    from headroom.transforms.content_router import ContentRouter

    if not hasattr(AnthropicHandlerMixin, "_sort_tools_deterministically"):
        raise SystemExit(
            "siso-headroom: expected tool-order hook is missing; refusing startup"
        )
    if not callable(getattr(tool_schema_compaction, "compact_tools", None)):
        raise SystemExit(
            "siso-headroom: expected schema-compaction hook is missing; refusing startup"
        )
    original_process_content_blocks = getattr(
        ContentRouter, "_process_content_blocks", None
    )
    if not callable(original_process_content_blocks):
        raise SystemExit(
            "siso-headroom: expected content-block hook is missing; refusing startup"
        )

    AnthropicHandlerMixin._sort_tools_deterministically = classmethod(
        _preserve_tools
    )
    tool_schema_compaction.compact_tools = _preserve_tool_schemas
    ContentRouter._process_content_blocks = lambda router, message, content_blocks, *args, **kwargs: _preserve_list_form_tool_results(
        original_process_content_blocks,
        router,
        message,
        content_blocks,
        *args,
        **kwargs,
    )


install_siso_safety_patch()

from headroom.cli import main  # noqa: E402


if __name__ == "__main__":
    sys.exit(main())
