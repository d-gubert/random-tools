import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs, UsageError, helpText, type ListArgs, type TraceArgs } from '../../src/cli/args.js';

const usage = (re: RegExp) => (e: unknown) => e instanceof UsageError && re.test(e.message);

/** The arguments of the `trace` mode (the default). */
function trace(argv: string[]): TraceArgs {
  const args = parseArgs(argv);
  if (args.mode !== 'trace') assert.fail(`expected the trace mode, got ${args.mode}`);
  return args;
}

function list(argv: string[]): ListArgs {
  const args = parseArgs(argv);
  if (args.mode !== 'list') assert.fail(`expected the list mode, got ${args.mode}`);
  return args;
}

test('no arguments give the trace mode with the defaults', () => {
  assert.deepEqual(parseArgs([]), { mode: 'trace', output: { kind: 'default' }, limit: 20 });
});

test('the session argument is a path or an ID', () => {
  assert.equal(trace(['a/b.jsonl']).session, 'a/b.jsonl');
  assert.equal(trace(['abcd1234']).session, 'abcd1234');
  assert.equal(trace(['-n', '3', 'abcd']).session, 'abcd');
  assert.equal(trace(['--', '-odd.jsonl']).session, '-odd.jsonl');
});

test('a second session argument is a usage error', () => {
  assert.throws(() => parseArgs(['a', 'b']), usage(/unexpected argument "b"/));
});

test('-o and --output', () => {
  assert.deepEqual(trace(['-o', 'x.html']).output, { kind: 'file', path: 'x.html' });
  assert.deepEqual(trace(['--output', 'x.html']).output, { kind: 'file', path: 'x.html' });
  assert.deepEqual(trace(['--output=x.html', 's']).output, { kind: 'file', path: 'x.html' });
  assert.throws(() => parseArgs(['-o']), usage(/-o needs a value/));
  assert.throws(() => parseArgs(['-o', '--stdout']), usage(/-o needs a value/));
});

test('--stdout', () => {
  assert.deepEqual(trace(['--stdout']).output, { kind: 'stdout' });
  assert.throws(() => parseArgs(['--stdout=1']), usage(/takes no value/));
});

test('without -o and --stdout, the output target is the default', () => {
  assert.deepEqual(trace(['s']).output, { kind: 'default' });
});

test('-o with --stdout is a usage error, in either order', () => {
  assert.throws(() => parseArgs(['-o', 'x.html', '--stdout']), usage(/cannot be used together/));
  assert.throws(() => parseArgs(['--stdout', '--output', 'x.html']), usage(/cannot be used together/));
});

test('-f and --format', () => {
  assert.equal(trace(['-f', 'claude-code']).format, 'claude-code');
  assert.equal(trace(['--format', 'claude-code']).format, 'claude-code');
  assert.equal(trace(['--format=claude-code']).format, 'claude-code');
  assert.throws(() => parseArgs(['-f']), usage(/-f needs a value/));
  assert.equal('format' in trace([]), false);
});

test('-l and --list give the list mode', () => {
  assert.deepEqual(parseArgs(['-l']), { mode: 'list', limit: 20 });
  assert.deepEqual(parseArgs(['--list']), { mode: 'list', limit: 20 });
  assert.deepEqual(parseArgs(['--list', '-f', 'claude-code']), { mode: 'list', limit: 20, format: 'claude-code' });
});

test('the list mode has no session and no output target', () => {
  const args = list(['-l']);
  assert.equal('session' in args, false);
  assert.equal('output' in args, false);
});

test('-n and --limit', () => {
  assert.equal(trace(['-n', '5']).limit, 5);
  assert.equal(trace(['--limit', '7']).limit, 7);
  assert.equal(trace(['--limit=9']).limit, 9);
});

test('-n with a bad number is a usage error', () => {
  for (const bad of ['x', '0', '1.5', '', '5x']) {
    assert.throws(() => parseArgs(['-n', bad]), usage(/invalid number/), `"${bad}"`);
  }
  assert.throws(() => parseArgs(['--limit=-3']), usage(/invalid number/));
  assert.throws(() => parseArgs(['-n', '-3']), usage(/-n needs a value/));
  assert.throws(() => parseArgs(['-n']), usage(/-n needs a value/));
});

test('-h, --help, -v, --version', () => {
  assert.deepEqual(parseArgs(['-h']), { mode: 'help' });
  assert.deepEqual(parseArgs(['--help']), { mode: 'help' });
  assert.deepEqual(parseArgs(['-v']), { mode: 'version' });
  assert.deepEqual(parseArgs(['--version']), { mode: 'version' });
});

test('the modes have a priority: help, then version, then list', () => {
  assert.equal(parseArgs(['-v', '-h']).mode, 'help');
  assert.equal(parseArgs(['-l', '-v']).mode, 'version');
  assert.equal(parseArgs(['-l', '-h']).mode, 'help');
  assert.equal(parseArgs(['-h', 'some-session']).mode, 'help');
});

test('an unknown option is a usage error', () => {
  assert.throws(() => parseArgs(['--nope']), usage(/unknown option "--nope"/));
  assert.throws(() => parseArgs(['-x']), usage(/unknown option "-x"/));
  assert.throws(() => parseArgs(['--nope=1']), usage(/unknown option "--nope"/));
});

test('the help text lists the format ids', () => {
  const text = helpText(['claude-code', 'other']);
  assert.match(text, /claude-code, other/);
  for (const opt of ['--output', '--stdout', '--format', '--turn-content', '--list', '--limit', '--help', '--version']) assert.ok(text.includes(opt), opt);
});

test('the help text lists the turn-content ids and the default', () => {
  assert.match(helpText(['claude-code'], ['timeline', 'inspector'], 'timeline'), /--turn-content ID .*timeline, inspector; default: timeline/);
});

test('--turn-content', () => {
  assert.equal(trace(['--turn-content', 'inspector']).turnContent, 'inspector');
  assert.equal(trace(['--turn-content=timeline', 's']).turnContent, 'timeline');
  assert.equal('turnContent' in trace([]), false);
  assert.throws(() => parseArgs(['--turn-content']), usage(/--turn-content needs a value/));
  assert.throws(() => parseArgs(['--list', '--turn-content', 'inspector']), usage(/--list cannot be used/));
});

test('--list with a session, -o, or --stdout is a usage error', () => {
  assert.throws(() => parseArgs(['--list', 'abc']), UsageError);
  assert.throws(() => parseArgs(['-l', '-o', 'x.html']), UsageError);
  assert.throws(() => parseArgs(['--stdout', '--list']), UsageError);
  assert.throws(() => parseArgs(['-h', '-l', 'abc']), UsageError);
  assert.equal(list(['--list', '-n', '5']).limit, 5);
});
