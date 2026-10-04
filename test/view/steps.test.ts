import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toView } from '../../src/view/steps.js';
import { parseToolUseId, type RequestEvent, type Session, type SessionMeta } from '../../src/model.js';
import { readGoldenSession, readGoldenSteps } from '../support/golden.js';

/** Minimal session with the given request events. */
function sessionWith(requests: readonly RequestEvent[], meta: Partial<SessionMeta> = {}): Session {
  const base = readGoldenSession();
  return {
    meta: { ...base.meta, models: [], contextWindow: null, ...meta },
    events: [{ type: 'session_start', ts: '', hooks: [] }, ...requests, { type: 'session_end', ts: '', hooks: [] }],
  };
}

const request = (cacheRead: number, model = 'claude-x'): RequestEvent => ({
  type: 'request', ts: '', model, stopReason: 'end_turn',
  usage: { input: 0, cacheRead, cacheWrite: 0, output: 1, thinking: null },
  blocks: [], tools: [], hooks: [],
});

test('golden session gives the golden steps', () => {
  const view = toView(readGoldenSession());
  assert.deepEqual(view.steps, readGoldenSteps());
  assert.equal(view.meta.turns, 6);
  assert.equal(view.meta.window, 200000);
  assert.equal(view.meta.harnessName, 'Claude Code');
  assert.equal(view.meta.sessionId, readGoldenSession().meta.sessionId);
});

test('window: more than 200,000 context tokens gives 1,000,000', () => {
  assert.equal(toView(sessionWith([request(250000)])).meta.window, 1000000);
});

test('window: a [1m] model gives 1,000,000', () => {
  assert.equal(toView(sessionWith([request(10)], { models: ['claude-x[1m]'] })).meta.window, 1000000);
  assert.equal(toView(sessionWith([request(10, 'claude-x[1m]')])).meta.window, 1000000);
});

test('window: meta.contextWindow wins', () => {
  assert.equal(toView(sessionWith([request(250000)], { contextWindow: 32000 })).meta.window, 32000);
});

test('window: default is 200,000', () => {
  assert.equal(toView(sessionWith([request(10)])).meta.window, 200000);
  assert.equal(toView(sessionWith([])).meta.window, 200000);
});

test('harnessName shows in the start step and the other harness texts', () => {
  const s = readGoldenSession();
  const steps = toView({ ...s, meta: { ...s.meta, harnessName: 'Other Agent' } }).steps;
  assert.match(steps[0]?.d ?? '', /^Other Agent 2\.1\.200 starts in \/work\/app\./);
  const all = steps.map((x) => x.t + ' ' + x.d).join('\n');
  assert.doesNotMatch(all, /Claude Code/);
  assert.ok(steps.some((x) => x.t === 'Other Agent adds a message'));
});

test('one event gives one step; the turn number counts request events', () => {
  const s = readGoldenSession();
  const view = toView(s);
  assert.equal(view.steps.length, s.events.length);
  assert.equal(view.steps.at(-1)?.turn, 6);
  assert.equal(view.steps[0]?.turn, 0);
});

test('a request without usage keeps the context of the earlier step', () => {
  const noUsage: RequestEvent = { ...request(0), usage: null };
  const view = toView(sessionWith([request(1000), noUsage]));
  assert.equal(view.steps[1]?.ctx, 1000);
  assert.equal(view.steps[2]?.ctx, 1000);
  assert.equal(view.steps[2]?.turn, 2);
});

test('code block is cut at 60 lines', () => {
  const base = sessionWith([]);
  const items = Array.from({ length: 70 }, (_, i) => `item ${i}`);
  const s: Session = {
    ...base,
    events: [{ type: 'session_start', ts: '', hooks: [] }, { type: 'context', ts: '', items }, { type: 'session_end', ts: '', hooks: [] }],
  };
  const c = toView(s).steps[1]?.c ?? '';
  assert.equal(c.split('\n').length, 61);
  assert.match(c, /… \(10 more lines\)$/);
});

test('every step has at least one tag', () => {
  for (const step of toView(readGoldenSession()).steps) assert.ok(step.k.length >= 1, step.t);
});

test('details: one entry per step, a turn detail for each request step', () => {
  const s = readGoldenSession();
  const view = toView(s);
  assert.equal(view.details.length, view.steps.length);
  s.events.forEach((e, i) => assert.equal(view.details[i] !== null, e.type === 'request', `step ${i + 1}`));
  const turns = view.details.flatMap((d) => (d ? [d.n] : []));
  assert.deepEqual(turns, [1, 2, 3, 4, 5, 6]);
});

test('details: a tool call keeps its status, hooks, and result lines', () => {
  const view = toView(readGoldenSession());
  const first = view.details.find((d) => d !== null);
  assert.ok(first);
  assert.equal(first.stop, 'tool_use');
  assert.deepEqual(first.usage, { cacheRead: 12995, cacheWrite: 1000, input: 5, output: 100, thinking: null });
  assert.deepEqual(first.blocks, [{ type: 'thinking', text: 'Look at the layout first.' }, { type: 'tool_use', tool: 0 }]);
  const glob = first.tools[0];
  assert.ok(glob);
  assert.deepEqual(glob.arg, { kind: 'pattern', v: 'packages/apps/**/*.ts', extra: '' });
  assert.equal(glob.status, 'ok');
  assert.equal(glob.pre[0]?.name, 'PreToolUse:Glob');
  assert.equal(glob.post[0]?.name, 'PostToolUse:Glob');
  assert.deepEqual(glob.result, { lines: ['packages/apps/web/src/utils/date.ts', 'packages/apps/web/src/api/client.ts'], total: 2 });
});

test('details: result lines keep the indentation and stop at 2,000', () => {
  const lines = Array.from({ length: 2010 }, (_, i) => '    line ' + i);
  const req: RequestEvent = {
    ...request(10),
    stopReason: 'tool_use',
    blocks: [{ type: 'tool_use', toolId: parseToolUseId('t1') ?? assert.fail('id') }],
    tools: [{ id: parseToolUseId('t1') ?? assert.fail('id'), name: 'Read', input: { file_path: '/a/b.ts' }, pre: [], post: [], subagent: null, status: 'ok', result: { text: lines.join('\n') + '\n\n', isError: false } }],
  };
  const tool = toView(sessionWith([req])).details[1]?.tools[0];
  assert.deepEqual(tool?.arg, { kind: 'path', v: '/a/b.ts', extra: '' });
  assert.equal(tool?.result?.total, 2010);
  assert.deepEqual(tool?.result?.lines, lines.slice(0, 2000));
});

test('details: a command is kept in full, with its line breaks', () => {
  const command = "python3 - <<'EOF'\n" + 'x = 1\n'.repeat(200) + 'EOF';
  const req: RequestEvent = {
    ...request(10),
    stopReason: 'tool_use',
    blocks: [{ type: 'tool_use', toolId: parseToolUseId('t1') ?? assert.fail('id') }],
    tools: [{ id: parseToolUseId('t1') ?? assert.fail('id'), name: 'Bash', input: { command }, pre: [], post: [], subagent: null, status: 'ok', result: { text: 'ok', isError: false } }],
  };
  assert.deepEqual(toView(sessionWith([req])).details[1]?.tools[0]?.arg, { kind: 'cmd', v: command, extra: '' });
});
