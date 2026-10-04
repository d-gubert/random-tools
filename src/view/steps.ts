// Session → View. Knows the Session model only, never a log format.

import type { Hook, RequestEvent, Session, SessionEvent, SessionEndEvent, SessionId, Timestamp, ToolCall, ToolStatus, Usage } from '../model.js';
import { clip, quote, num, ktok, plural, times, duration, countNames, isRecord } from './text.js';

/** The tags of a step. They set the colors on the page. */
export type Kind = 'loop' | 'http' | 'tool' | 'hook' | 'ui';

export type Step = {
  /** Title. */
  readonly t: string;
  /** Tags. Invariant 7, enforced by the compiler: at least one. `k[0]` sets the color in the step list. */
  readonly k: readonly [Kind, ...Kind[]];
  /** Description. */
  readonly d: string;
  /** Code block text. */
  readonly c: string;
  /** Loop turn number (0 before the first request). */
  readonly turn: number;
  /** Context tokens (carried forward). */
  readonly ctx: number;
  /** ISO timestamp, or "" when unknown. */
  readonly ts: Timestamp;
};

export type ViewMeta = {
  readonly file: string;
  readonly sessionId: SessionId;
  readonly firstPrompt: string;
  readonly gitBranch: string;
  readonly harnessName: string;
  /** Number of request events. */
  readonly turns: number;
  /** Context window in tokens. */
  readonly window: number;
};

export type View = {
  readonly meta: ViewMeta;
  readonly steps: readonly Step[];
};

/** The part of a step that `describe` writes. */
type StepText = Pick<Step, 't' | 'k' | 'd' | 'c'>;

const MAX_CODE_LINES = 60;
const RESULT_LINES = 3;

const isRequest = (e: SessionEvent): e is RequestEvent => e.type === 'request';

// ---------------------------------------------------------------- helpers

function toolArg(name: string, input: unknown): string {
  if (!isRecord(input)) return '';
  const pick =
    input.command ?? input.file_path ?? input.notebook_path ?? input.pattern ?? input.url ??
    input.query ?? input.description ?? input.skill ?? input.prompt ?? input.path;
  if (typeof pick === 'string') return quote(pick, 110);
  if (name === 'TodoWrite') return '';
  return clip(JSON.stringify(input), 110);
}

/** A short label for the step list: what the call is about. "" when the input has nothing short. */
function toolHint(input: unknown): string {
  if (!isRecord(input)) return '';
  const path = input.file_path ?? input.notebook_path;
  if (typeof path === 'string') return path.split('/').pop() || path;
  const pick = input.description ?? input.pattern ?? input.skill ?? input.query ?? input.url ?? input.command;
  return typeof pick === 'string' ? clip(pick, 60) : '';
}

/** The tool hint when all calls share one, else "". */
function toolsHint(tools: readonly ToolCall[]): string {
  const hints = new Set(tools.map((t) => toolHint(t.input)));
  const [only] = hints;
  return hints.size === 1 && only ? only : '';
}

function todoLines(input: unknown): string[] {
  if (!isRecord(input) || !Array.isArray(input.todos)) return [];
  const todos: readonly unknown[] = input.todos;
  const box: Readonly<Record<string, string>> = { completed: '[x]', in_progress: '[~]' };
  return todos.slice(0, 12).map((t) => {
    const todo = isRecord(t) ? t : {};
    const status = typeof todo.status === 'string' ? todo.status : '';
    return `  ${box[status] || '[ ]'} ${clip(todo.content, 90)}`;
  });
}

const hookLine = (h: Hook): string =>
  `hook: ${h.name} → ${h.outcome}` + (h.command ? `\n  $ ${clip(h.command, 100)}` : '') + (h.detail ? `\n  ${quote(h.detail)}` : '');

/** Context tokens of a request, or null when the log has no usage. */
function ctxOf(e: RequestEvent): number | null {
  const u = e.usage;
  if (!u) return null;
  return (u.input || 0) + (u.cacheRead || 0) + (u.cacheWrite || 0);
}

function contextWindow(session: Session): number {
  const w = session.meta.contextWindow;
  if (typeof w === 'number') return w;
  const events: readonly SessionEvent[] = session.events;
  const reqs = events.filter(isRequest);
  const maxCtx = Math.max(0, ...reqs.map((e) => ctxOf(e) || 0));
  const models = [...(session.meta.models || []), ...reqs.map((e) => e.model)];
  return maxCtx > 200000 || models.some((m) => /\[1m\]/i.test(m || '')) ? 1000000 : 200000;
}

// ---------------------------------------------------------------- view

export function toView(session: Session): View {
  const { meta, events } = session;
  const view: ViewMeta = {
    file: meta.file,
    sessionId: meta.sessionId,
    firstPrompt: meta.firstPrompt,
    gitBranch: meta.gitBranch,
    harnessName: meta.harnessName,
    turns: events.filter(isRequest).length,
    window: contextWindow(session),
  };
  return { meta: view, steps: render(session) };
}

function render(session: Session): Step[] {
  const events: readonly SessionEvent[] = session.events;
  let turn = 0;
  let ctx = 0;
  let promptNo = 0;

  return events.map((e, i) => {
    if (e.type === 'request') {
      turn++;
      ctx = ctxOf(e) ?? ctx;
    }
    if (e.type === 'compaction') {
      // The compaction step shows the context of the first request after it.
      for (const x of events.slice(i + 1)) {
        if (!isRequest(x)) continue;
        const after = ctxOf(x);
        if (after != null) {
          ctx = after;
          break;
        }
      }
    }
    if (e.type === 'prompt') promptNo++;
    const out = describe(session, e, events[i + 1], promptNo, turn);
    const code = out.c.split('\n');
    const c = code.length > MAX_CODE_LINES ? code.slice(0, MAX_CODE_LINES).join('\n') + `\n… (${code.length - MAX_CODE_LINES} more lines)` : out.c;
    return { ...out, c, turn, ctx, ts: e.ts };
  });
}

/**
 * @param s     the event to describe
 * @param next  the event after `s`, when there is one
 * @param turn  the loop turn number at `s`: the number of requests up to and including `s`
 */
function describe(session: Session, s: SessionEvent, next: SessionEvent | undefined, promptNo: number, turn: number): StepText {
  const { meta } = session;
  const who = meta.harnessName;
  const hooks = 'hooks' in s ? s.hooks : [];
  const hookK: readonly ('hook')[] = hooks.length ? ['hook'] : [];
  switch (s.type) {
    case 'session_start': {
      const d = [`${who} ${meta.version || ''} starts`.replace(/\s+starts/, ' starts') + (meta.cwd ? ` in ${meta.cwd}` : '') + '.'];
      d.push(hooks.length ? `The SessionStart hook runs ${times(hooks.length)}. Its stdout can add context to the session.` : 'The transcript records no SessionStart hook.');
      const c = [
        `session: ${meta.sessionId}`,
        meta.cwd && `cwd:     ${meta.cwd}`,
        meta.gitBranch && `branch:  ${meta.gitBranch}`,
        `version: ${meta.version || '?'}` + (meta.entrypoint ? `   entry: ${meta.entrypoint}` : ''),
        meta.models.length && `model:   ${meta.models.join(', ')}`,
        ...hooks.map(hookLine),
      ];
      return { t: 'Session starts', k: hooks.length ? ['hook', 'loop'] : ['loop'], d: d.join(' '), c: c.filter(Boolean).join('\n') };
    }
    case 'context':
      return {
        t: 'Build the context',
        k: ['loop'],
        d: `${who} builds the system prompt and the tool definitions. It adds the skills, the agents, and the MCP servers. The transcript records the parts below.`,
        c: s.items.join('\n'),
      };
    case 'prompt': {
      const d = ['You type the request.'];
      if (hooks.length) d.push(`The UserPromptSubmit hook runs ${times(hooks.length)}. The hook can block the prompt or add context to it.`);
      d.push('The agent loop starts.');
      const lines = s.text.split('\n').slice(0, 12).map((l) => '> ' + l);
      return { t: promptNo > 1 ? `User sends prompt ${promptNo}` : 'User sends the prompt', k: ['ui', ...hookK], d: d.join(' '), c: [...lines, '', ...hooks.map(hookLine)].join('\n').trimEnd() };
    }
    case 'command': {
      const out = (s.output || '').split('\n').filter((l) => l.trim()).slice(0, 8).map((l) => '→ ' + clip(l));
      const name = s.name === '!' ? 'a shell command' : `the command ${s.name}`;
      return {
        t: s.name === '!' ? 'You run a shell command' : `Slash command ${s.name}`,
        k: ['ui', ...hookK],
        d: `You run ${name}. ${who} handles it in the CLI.`,
        c: [`> ${s.name === '!' ? '! ' : s.name + ' '}${s.args}`.trimEnd(), ...out, ...hooks.map(hookLine)].join('\n'),
      };
    }
    case 'interrupt':
      return { t: 'You interrupt the turn', k: ['ui', 'loop'], d: `You stop the agent loop. ${who} waits for your next prompt.`, c: '[Request interrupted by user]' };
    case 'notice':
      return { t: `${who} adds a message`, k: ['loop'], d: `${who} writes this assistant message itself. No API request occurs.`, c: clip(s.text, 400) };
    case 'api_error':
      return {
        t: s.count > 1 ? `API error ×${s.count}` : 'API error',
        k: ['http'],
        d: `The Messages API returns an error. ${who} waits and sends the request again.`,
        c: `POST /v1/messages\n← error: ${clip(s.message, 140)}` + (s.count > 1 ? `\nretries: ${s.count}` : ''),
      };
    case 'compaction': {
      const d = [s.trigger === 'manual' ? 'You run /compact.' : `The context comes close to the limit, so ${who} compacts it.`];
      if (hooks.length) d.push('The PreCompact hook runs first.');
      d.push('One extra API request writes a summary. The summary replaces the old messages.');
      const sum = (s.summary || '').split('\n').filter((l) => l.trim()).slice(0, 6).map((l) => '  ' + clip(l, 120));
      const c = [...hooks.map(hookLine), `trigger: "${s.trigger}"` + (s.preTokens ? `   before: ${num(s.preTokens)} tokens` : ''), 'POST /v1/messages  → summary of the conversation', 'messages = [summary, recent turns]', ...(sum.length ? ['', 'summary:', ...sum] : [])];
      return { t: s.trigger === 'manual' ? 'Compact (manual)' : 'Auto-compact', k: ['loop', 'http', ...hookK], d: d.join(' '), c: c.join('\n') };
    }
    case 'stop_hooks': {
      const continued = next !== undefined && next.type === 'request';
      const infos = hooks.length ? hooks.map(hookLine) : (s.commands || []).map((cmd) => `hook: Stop\n  $ ${clip(cmd, 100)}`);
      const errs = hooks.length ? [] : (s.errors || []).map((e) => `→ ${quote(e, 140)}`);
      const d = ['The Stop hook runs when the loop exits.'];
      if (continued) d.push('The hook returns a block decision. The loop continues with the reason as input.');
      else if (s.prevented) d.push('The hook stops the session.' + (s.reason ? ` The reason is: ${clip(s.reason, 80)}` : ''));
      else d.push('The hook lets the loop exit.');
      // The next request is the next loop turn.
      return { t: 'Stop hook', k: ['hook', 'loop'], d: d.join(' '), c: [...infos, ...errs, continued ? `→ loop continues (turn ${turn + 1}) …` : ''].join('\n').trimEnd() };
    }
    case 'request':
      return describeRequest(s, turn);
    case 'session_end':
      return describeEnd(session, s);
    default: {
      // The compiler stops here when a new event kind has no case above.
      const unknownEvent: never = s;
      void unknownEvent;
      return { t: 'event', k: ['loop'], d: '', c: '' };
    }
  }
}

/** @param n turn number */
function describeRequest(s: RequestEvent, n: number): StepText {
  const u: Partial<Usage> = s.usage || {};
  const ctx = ctxOf(s) || 0;
  const tools = s.tools;
  const status = tools.map((t) => t.status);
  const errors = status.filter((x) => x === 'error').length;
  const rejected = status.filter((x) => x === 'rejected').length;
  const toolHooks = tools.reduce((m, t) => m + t.pre.length + t.post.length, 0);
  const blocked = tools.filter((t) => t.pre.some((h) => h.outcome === 'block' || h.outcome === 'deny')).length;
  const allHooks = toolHooks + s.hooks.length;

  const first = tools[0];
  const hint = toolsHint(tools);
  const title =
    `Turn ${n}: ` +
    (tools.length ? countNames(tools.map((t) => t.name)) + (hint ? ` · ${hint}` : '') : s.stopReason === 'end_turn' ? 'end_turn' : s.stopReason || 'text reply');
  const k: [Kind, ...Kind[]] = ['http', tools.length ? 'tool' : 'loop'];
  if (allHooks) k.push('hook');
  if (rejected || status.includes('interrupted')) k.push('ui');

  const d = [`The agent loop sends request ${n} to the Messages API with ${ktok(ctx)} tokens of context.`];
  if (s.blocks.some((b) => b.type === 'thinking' || b.type === 'redacted_thinking')) d.push('The model thinks first.');
  if (tools.length === 1 && first) d.push(`The model asks for one tool: ${first.name}.`);
  else if (tools.length > 1) d.push(`The model asks for ${tools.length} tools in one response.`);
  if (toolHooks) d.push(`The PreToolUse and PostToolUse hooks run ${times(toolHooks)}.`);
  if (blocked) d.push(`A PreToolUse hook blocks ${plural(blocked, 'tool call')}.`);
  if (rejected) d.push(`You reject ${plural(rejected, 'tool call')}.`);
  if (errors) d.push(`${plural(errors, 'tool call')} ${errors === 1 ? 'returns' : 'return'} an error.`);
  if (tools.length) d.push('The results go into messages[] as tool_result blocks.');
  else if (s.stopReason === 'end_turn') d.push('The model returns text with no tool_use. The agent loop exits.');
  else if (s.stopReason === 'max_tokens') d.push('The response reaches the max_tokens limit.');

  const c = [
    `POST /v1/messages   model: ${s.model || '?'}`,
    `  context: ${num(ctx)} tokens (cache read ${num(u.cacheRead)} · cache write ${num(u.cacheWrite)} · new ${num(u.input)})`,
  ];
  for (const b of s.blocks) {
    if (b.type === 'thinking') {
      c.push(b.text ? `← thinking: ${quote(b.text, 110)}` : `← thinking${u.thinking ? ` (${num(u.thinking)} tokens)` : ''}`);
    } else if (b.type === 'redacted_thinking') c.push('← thinking (redacted)');
    else if (b.type === 'text' && b.text.trim()) c.push(`← text: ${quote(b.text, 200)}`);
    else if (b.type === 'tool_use') {
      const tool = tools.find((t) => t.id === b.toolId);
      if (!tool) {
        c.push('← tool_use: ?');
        continue;
      }
      c.push(`← tool_use: ${tool.name}  ${toolArg(tool.name, tool.input)}`.trimEnd());
      if (tool.name === 'TodoWrite') c.push(...todoLines(tool.input));
    } else if (b.type === 'server_tool_use') c.push(`← server_tool_use: ${b.name}  ${toolArg(b.name, b.input)}`.trimEnd());
  }
  c.push(`← stop_reason: "${s.stopReason || '?'}"   output: ${num(u.output)} tokens`);

  if (tools.length) c.push('');
  const marks: Readonly<Record<ToolStatus, string>> = { ok: '✓', error: '✗ error', rejected: '✗ rejected by you', interrupted: '✗ interrupted', 'no result': '… no result' };
  for (const t of tools) {
    c.push(...t.pre.map(hookLine));
    c.push(`tool: ${t.name} ${marks[t.status]}`);
    if (t.result) {
      const lines = t.result.text.split('\n').filter((l) => l.trim());
      c.push(...lines.slice(0, RESULT_LINES).map((l) => '  → ' + clip(l, 120)));
      if (lines.length > RESULT_LINES) c.push(`  → … (${lines.length - RESULT_LINES} more lines)`);
    }
    if (t.subagent) {
      c.push(`  subagent: ${plural(t.subagent.toolCalls || 0, 'tool call')} · ${num(t.subagent.tokens)} tokens · ${duration(t.subagent.durationMs)}`);
    }
    c.push(...t.post.map(hookLine));
  }
  const results = tools.filter((t) => t.result).length;
  if (results) c.push(`messages += tool_result ×${results}`);
  if (s.hooks.length) c.push('', ...s.hooks.map(hookLine));
  return { t: title, k, d: d.join(' '), c: c.join('\n') };
}

function describeEnd(session: Session, s: SessionEndEvent): StepText {
  const { meta } = session;
  const events: readonly SessionEvent[] = session.events;
  const reqs = events.filter(isRequest);
  const tools = reqs.flatMap((x) => x.tools);
  const hookRuns = events.reduce((n, x) => {
    const own = 'hooks' in x ? x.hooks.length : 0;
    const toolHooks = x.type === 'request' ? x.tools.reduce((m, t) => m + t.pre.length + t.post.length, 0) : 0;
    return n + own + toolHooks;
  }, 0);
  const sum = (key: 'input' | 'cacheRead' | 'cacheWrite' | 'output'): number => reqs.reduce((n, x) => n + (x.usage?.[key] || 0), 0);
  const ms = Date.parse(meta.endedAt) - Date.parse(meta.startedAt);
  const last = [...reqs].reverse().find((x) => x.usage);
  const d = [
    `The transcript ends. The session lasts ${duration(ms)}.`,
    `It has ${plural(reqs.length, 'API request')}, ${plural(tools.length, 'tool call')}, and ${plural(hookRuns, 'recorded hook run')}.`,
  ];
  if (s.hooks.length) d.push('The SessionEnd hook runs for cleanup or logs.');
  const c = [
    `requests:   ${reqs.length}`,
    `tool calls: ${tools.length}` + (tools.length ? `  (${countNames(tools.map((t) => t.name))})` : ''),
    `hook runs:  ${hookRuns}`,
    `tokens:     output ${num(sum('output'))} · cache read ${num(sum('cacheRead'))} · cache write ${num(sum('cacheWrite'))} · new ${num(sum('input'))}`,
    last && `last context: ${num(ctxOf(last))} tokens`,
    ...s.hooks.map(hookLine),
  ];
  return { t: 'Session ends', k: ['ui', ...(s.hooks.length ? (['hook'] as const) : [])], d: d.join(' '), c: c.filter(Boolean).join('\n') };
}
