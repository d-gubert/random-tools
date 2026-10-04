# yast

**yast** means **Yet Another Session Tracer**. It reads a Claude Code session log (`.jsonl`). It writes one HTML page that shows the session step by step. The page uses the layout of the "Claude Code session trace" artifact, with real data instead of a simulation.

<img width="1077" height="976" alt="image" src="https://github.com/user-attachments/assets/87e4cac5-2255-44b6-88de-31414cd883f4" />

The tool is written in TypeScript. It has no runtime dependencies and needs Node.js 18 or later. To build it, you need `typescript` and `@types/node` (dev dependencies, installed by `npm install`).

> **Warning:** The page contains the prompts, the tool inputs, and the tool results of the session. These can include secrets, file contents, and private paths. Read the page before you share it.

## Quick start

1. Install the dependencies and build the tool:

   ```sh
   npm install
   ```

2. Link the command:

   ```sh
   npm link
   ```

3. Run yast with no argument. Pick a session from the list:

   ```sh
   yast
   ```

4. Open the file `<session-id>.trace.html` from the current directory in a browser.

## Install

Build the tool, then run it from the repository:

```sh
npm install      # installs the dev dependencies, and builds to dist/ (the "prepare" script)
node dist/bin/yast.js --help
```

Or link it, to get the `yast` command:

```sh
npm link
yast --help
```

`npm run build` compiles `bin/`, `src/`, and `test/` to `dist/` with `tsc`. It also copies `src/render/page.html` to `dist/src/render/`. Build again after you change a source file. `dist/` is not in git.

## Usage

```sh
# List the sessions and pick one
yast

# Use a session file, a session ID, or the start of an ID
yast ~/.claude/projects/-home-me-app/5690d737-0b97-5806-b338-6ce2108dabab.jsonl
yast 5690d737-0b97-5806-b338-6ce2108dabab
yast 5690d737

# Choose the output file, or write to stdout
yast <session> -o out/trace.html
yast <session> --stdout > trace.html

# Only list the sessions
yast --list
yast --list -n 50
```

An ID prefix must have at least 4 characters. If more than one session matches, yast prints the paths and exits with code 1.

### No session argument

If you give no session, yast lists the sessions of the profile directory, newest first.

- In a terminal, yast asks you to pick one. Type a number and press Enter. Press Enter alone to pick 1. Type `q` to quit (exit code 130). After 3 wrong answers, yast exits with code 2.
- Without a terminal, yast prints the list and exits with code 2. Pass a session path or ID to avoid this.

## Options

```
usage: yast [options] [session]

  session            path to a session log, or a session ID (or a unique ID prefix)
  -o, --output FILE  write the page to FILE
      --stdout       write the page to stdout
  -f, --format ID    log format; default: detect (claude-code)
  -l, --list         list the sessions and exit
  -n, --limit N      number of sessions in the list (default 20)
  -h, --help         show this help
  -v, --version      show the version
```

Rules:

- `-o` and `--stdout` cannot be used together.
- `--list` cannot be used with a session, `-o`, or `--stdout`.
- `-f` selects a format by its ID. Without `-f`, yast detects the format from the file.
- `-o` does not create directories. The directory of `FILE` must exist.

### Exit codes

| Code | Meaning |
| --- | --- |
| 0 | yast did its job. |
| 1 | Error: no such session, no sessions found, unknown log format, or a file error. |
| 2 | Usage error, or no session argument without a terminal. |
| 130 | You quit the picker. |

## The profile directory

yast looks for sessions in the profile directory of Claude Code:

- If `CLAUDE_CONFIG_DIR` is set, the profile directory is `$CLAUDE_CONFIG_DIR`.
- Otherwise, it is `~/.claude`.

The session files are `<profile>/projects/*/*.jsonl`. Set `CLAUDE_CONFIG_DIR` to read the sessions of another profile:

```sh
CLAUDE_CONFIG_DIR=~/.claude-work yast --list
```

## Output rules

1. With `--stdout`, yast writes the page to stdout. It writes no file.
2. With `-o FILE`, yast writes the page to `FILE`. A relative path starts at the current directory.
3. Otherwise, yast writes `<session-id>.trace.html` in the current directory. The session ID is the file name without `.jsonl`.

yast does not overwrite a file. When the output file exists, yast writes `<name>.1.html`, then `<name>.2.html`, and so on. It uses the first free number.

When yast writes a file, it prints the input path, the output path, and the number of steps and loop turns to stderr.

## How to read the page

The page has these parts:

- A legend with five colors: agent loop, HTTP API request, tool call, hook, and user / UI.
- A timeline track with one cell for each step.
- A list of steps, the Previous, Next, and Play controls, and the arrow keys.
- A "Loop turn" meter and a "Context in messages[]" meter.
- A card for each step with tags, a title, a description, and a code block.

To move through the session, press the left and right arrow keys. Press Play to step through the session automatically.

## How the transcript maps to steps

The table shows the Claude Code format. A format module turns these records into the session model. The view then makes the steps.

| Transcript records | Step |
| --- | --- |
| The first record, `SessionStart` hook records | Session starts |
| Attachments before the first request (system prompt, tools, skills, MCP servers, CLAUDE.md) | Build the context |
| A `user` record with prompt text | User sends the prompt |
| All `assistant` records with the same `message.id`, their `tool_result` records, and the `PreToolUse` and `PostToolUse` hooks | Turn N |
| `system` / `api_error` | API error |
| `system` / `compact_boundary`, the compact summary, `PreCompact` hooks | Auto-compact or Compact (manual) |
| `system` / `stop_hook_summary`, `Stop` hooks | Stop hook |
| `<command-name>` and `<bash-input>` prompts | Slash command, shell command |
| `[Request interrupted by user]` | You interrupt the turn |
| An assistant message with the model `<synthetic>` | Claude Code adds a message |
| The last record, `SessionEnd` hooks | Session ends |

The context meter shows `input_tokens + cache_read_input_tokens + cache_creation_input_tokens` of each request. The window is 200k tokens. If the model name contains `[1m]` or a request uses more than 200k tokens, the window is 1M tokens.

## Limits

- The page shows only the hooks that Claude Code writes to the transcript. Some versions of Claude Code do not write all hook events.
- The page does not show the turns of subagents. The Agent tool step shows the totals of the subagent: tool calls, tokens, and time.
- The transcript format is not a public API. A new version of Claude Code can change it. The parser ignores record types that it does not know.
- yast reads sessions from the Claude Code profile directory only. For a log in another place, pass its path.

## Development

### Module layout

```
bin/yast.ts   entry: builds the real I/O and calls run()
src/cli/               args, run, session picker, session list table
src/sources/           find session files on disk
src/formats/           parse one log file into a Session
src/model.ts           the Session model (the contract: types, and the makers of the branded types)
src/view/              Session -> View (the steps)
src/render/            View -> HTML (page.html is the page template; the build copies it)
test/                  node:test tests (TypeScript), type tests, golden files, and the fixture
scripts/dist.mjs       build helper: clean dist/, copy page.html
docs/                  the plan, the task files, and the format guide
dist/                  the build output (not in git); `bin` of package.json points here
```

Data flow: `source -> path -> format.parse -> Session -> toView -> renderHtml -> file`.

Only `src/cli/run.ts` joins the other modules. A format knows only the model. The view knows only the model. The renderer gets a View. `test/layers.test.ts` checks these rules on the imports.

### The types

The rules of the data are in the types of `src/model.ts`. The compiler rejects data that breaks them, and `test/types/invariants.test.ts` shows each rejection with `// @ts-expect-error`. The model data is `readonly`. The JSON of a log is `unknown` until a check narrows it.

- `Session.events` is a tuple type: `session_start` first, `session_end` last, neither anywhere else, and at most one `context` event, directly after `session_start`.
- `SessionEvent` is a union on `type`. `ToolCall` has `result: null` exactly when `status` is `'no result'`.
- `SessionId`, `ToolUseId`, and `PositiveCount` are branded types. A timestamp is an ISO string, or `''` when unknown.
- `Step.k` has at least one tag. The CLI arguments are one of four modes (`help`, `version`, `list`, `trace`). `-o` with `--stdout` has no representation. Exit codes are `0 | 1 | 2 | 130`. The format registry and the source registry are non-empty readonly tuples.

What a type cannot say is checked at run time: that a `tool_use` block has its call, and that `api_error.count` is 1 or more. See `test/model/invariants.test.ts`.

To support the logs of another harness, add a format module. See [docs/adding-a-format.md](docs/adding-a-format.md).

### Test

```sh
npm run typecheck   # tsc --noEmit: the type rules, and the type tests of the invariants
npm test            # builds, then runs the compiled tests: node --test 'dist/test/**/*.test.js'
```

Node 22 does not accept a directory as an argument of `node --test`, so `npm test` uses a glob. The tests are TypeScript and run from `dist/test/`. To run some tests, build first, then use a glob:

```sh
npm run build
node --test 'dist/test/e2e/*.test.js'
```

The tests use `test/fixture.jsonl` and the golden files in `test/golden/`. The fixture has hooks, a rejected tool call, a PreToolUse block, API errors, a subagent, a compaction, a blocking Stop hook, a slash command, and an interruption. The end-to-end tests run the compiled CLI (`dist/bin/yast.js`) as a child process. They use a temporary profile and a temporary directory.
