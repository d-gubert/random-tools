---
description: Show one captured exchange - the request and the reassembled streamed response
argument-hint: "[id|last|-N] [--full]"
allowed-tools: Bash(node:*), Read
---
!`node "${CLAUDE_PLUGIN_ROOT}/bin/http-inspect.mjs" show $ARGUMENTS`

Show the capture above to the user in a code block. The capture folder holds the raw files: `request.body` (the exact bytes sent), `chunks.jsonl` (each network chunk, with a timestamp in ms from the request start), and `events.jsonl` (each parsed SSE event). Read those files only if the user asks about a detail that the summary does not show.
