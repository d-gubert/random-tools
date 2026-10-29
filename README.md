# http-inspect

A Claude Code plugin that records the raw HTTP request Claude Code sends to the
model API, and every chunk of every response, so you can inspect them.

## How it works

Claude Code sends its API traffic to `ANTHROPIC_BASE_URL`. The plugin runs a
local reverse proxy on `http://127.0.0.1:8790`. When `ANTHROPIC_BASE_URL`
points at the proxy, the proxy forwards each request to the real API and
writes a copy to disk. The response streams back to Claude Code unchanged.

A plugin cannot set `ANTHROPIC_BASE_URL` for you. Claude Code reads it at
startup, and it ignores that variable from plugin settings. You set it
yourself (see below).

## Install

```sh
git clone -b claude/http-inspection-plugin-71kz8n https://github.com/d-gubert/random-tools http-inspect
claude plugin marketplace add ./http-inspect
claude plugin install http-inspect@http-inspect
```

To try it without an install, use `claude --plugin-dir ./http-inspect/plugins/http-inspect`.

## Capture a session

Option 1: the launcher starts the proxy and runs `claude` through it.

```sh
node http-inspect/plugins/http-inspect/bin/http-inspect.mjs run -- [claude args]
```

Option 2: set the variable yourself.

```sh
ANTHROPIC_BASE_URL=http://127.0.0.1:8790 claude
```

With option 2, the plugin's `SessionStart` hook starts the proxy. Claude Code
can send a request before the hook runs. To capture that request too, start
the proxy first with `http-inspect.mjs start`.

To capture every session, add the variable to `~/.claude/settings.json`:

```json
{ "env": { "ANTHROPIC_BASE_URL": "http://127.0.0.1:8790" } }
```

Warning: with this setting, Claude Code cannot reach the API when the proxy
is down. Remove the setting when you stop the inspection.

## Inspect the captures

In Claude Code:

- `/http-inspect:status` shows the proxy state and whether this session is captured.
- `/http-inspect:list [n]` lists the last captured exchanges.
- `/http-inspect:show [id|last|-N] [--full]` shows the request and the reassembled response.

From a shell, the same script has `status`, `list`, `show`, `path`, `start`
and `stop` subcommands.

Each exchange gets a folder in
`~/.claude/http-inspect/captures/<session-id>/<YYYYMMDD>/<HHMMSS>-<seq>/`.
The session ID comes from the `x-claude-code-session-id` header (`no-session`
when the header is absent). Each session has its own sequence number.
The folder holds these files:

| File | Content |
| --- | --- |
| `request.json` | Method, path, upstream URL, headers, and the header changes on forward |
| `request.body` | The exact request bytes |
| `request.body.json` | The same body, pretty-printed |
| `response.json` | Status, headers, time to first byte, total time, byte and chunk counts |
| `chunks.jsonl` | One line per network chunk: `seq`, `t` (ms from the request start), `bytes`, `text` (and `base64` when the chunk splits a UTF-8 character) |
| `events.jsonl` | One line per parsed SSE event: `seq`, `t`, `event`, `data` |
| `response.body` | The raw response bytes |

`~/.claude/http-inspect/index.jsonl` holds one summary line per exchange.
WebSocket upgrades pass through. The index records the handshake, but the
proxy does not capture the frames.

## Settings

| Variable | Default | Effect |
| --- | --- | --- |
| `HTTP_INSPECT_PORT` | `8790` | The proxy port. Change `ANTHROPIC_BASE_URL` to match. |
| `HTTP_INSPECT_DIR` | `~/.claude/http-inspect` | The capture folder. |
| `HTTP_INSPECT_UPSTREAM` | `ANTHROPIC_BASE_URL` before the proxy, else `https://api.anthropic.com` | The real API. |
| `HTTP_INSPECT_REDACT` | `1` | `0` keeps `authorization`, `x-api-key` and cookies in the capture. |
| `HTTP_INSPECT_KEEP_ENCODING` | unset | `1` forwards `Accept-Encoding` as sent. By default the proxy asks for an uncompressed reply, so the chunks are readable. `request.json` records this change. |
| `HTTP_INSPECT_QUIET` | unset | `1` hides the "not capturing" message at session start. |

The proxy honors `HTTPS_PROXY` and `NO_PROXY` for the upstream connection.

Warning: the captures hold your prompts, your files and the model replies.
The proxy redacts the auth headers, but not the request bodies. Delete
`~/.claude/http-inspect/captures` when you finish.

## Requirements

Node.js 18 or later. The plugin has no dependencies.
