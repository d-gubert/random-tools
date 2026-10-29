---
description: Show the http-inspect proxy state and whether this session is captured
allowed-tools: Bash(node:*)
---
!`node "${CLAUDE_PLUGIN_ROOT}/bin/http-inspect.mjs" status`

Report the status above to the user in two or three lines. If this session is not captured, tell them to restart Claude Code with `ANTHROPIC_BASE_URL=http://127.0.0.1:8790`.
