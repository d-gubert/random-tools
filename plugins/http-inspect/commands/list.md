---
description: List the captured model requests (newest last)
argument-hint: "[count]"
allowed-tools: Bash(node:*)
---
!`node "${CLAUDE_PLUGIN_ROOT}/bin/http-inspect.mjs" list $ARGUMENTS`

Show the list above to the user as is, in a code block. Do not add commentary.
