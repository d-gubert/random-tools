import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, copyFile, readFile, readdir, rm, utimes, writeFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { run, type ExitCode } from '../../src/cli/run.js';
import { FIXTURE, GOLDEN_STEPS, packageVersion } from '../support/paths.js';
import { pageData } from '../support/page.js';

const GOLDEN: unknown = JSON.parse(await readFile(GOLDEN_STEPS, 'utf8'));
const GOLDEN_COUNT = Array.isArray(GOLDEN) ? GOLDEN.length : NaN;

const ID_A = 'aaaa1111-0000-0000-0000-000000000001';
const ID_B = 'bbbb2222-0000-0000-0000-000000000002';

let tmp: string;
let profile: string;
let cwd: string;
let pathA: string;
let pathB: string;

before(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'pr-evaluator-cli-'));
  profile = join(tmp, 'profile');
  pathA = join(profile, 'projects', '-work-app', `${ID_A}.jsonl`);
  pathB = join(profile, 'projects', '-work-lib', `${ID_B}.jsonl`);
  for (const p of [pathA, pathB]) {
    await mkdir(join(p, '..'), { recursive: true });
    await copyFile(FIXTURE, p);
  }
  await utimes(pathA, 1_700_000_000, 1_700_000_000); // older
  await utimes(pathB, 1_700_100_000, 1_700_100_000); // newer: listed first
});

after(() => rm(tmp, { recursive: true, force: true }));

beforeEach(async () => {
  cwd = await mkdtemp(join(tmp, 'cwd-'));
});

async function go(
  argv: string[],
  opts: { input?: string; interactive?: boolean; config?: string; columns?: number } = {},
): Promise<{ code: ExitCode; out: string; err: string }> {
  let out = '';
  let err = '';
  const stdin = new PassThrough();
  stdin.end(opts.input ?? '');
  const code = await run(argv, {
    env: { CLAUDE_CONFIG_DIR: opts.config ?? profile },
    home: join(tmp, 'no-home'),
    cwd,
    stdin,
    stdout: { write: (s: string) => void (out += s) },
    stderr: { write: (s: string) => void (err += s) },
    interactive: opts.interactive ?? false,
    columns: opts.columns,
  });
  return { code, out, err };
}

const exists = (p: string) => access(p).then(() => true, () => false);

// ------------------------------------------------------------ rule 1: a session is given

test('a path: writes <name>.trace.html in the cwd and prints the summary', async () => {
  const { code, out, err } = await go([pathA]);
  assert.equal(code, 0);
  assert.equal(out, '');
  const target = join(cwd, `${ID_A}.trace.html`);
  assert.equal(err, `${pathA}\n→ ${target}  (${GOLDEN_COUNT} steps, 6 loop turns)\n`);
  assert.ok(await exists(target));
});

test('an existing output file is kept: the page goes to <name>.N.html', async () => {
  const first = join(cwd, `${ID_A}.trace.html`);
  await writeFile(first, 'old');
  const second = await go([pathA]);
  assert.equal(second.code, 0);
  assert.match(second.err, new RegExp(`→ ${join(cwd, `${ID_A}.trace.1.html`)} `));
  const third = await go([pathA]);
  assert.match(third.err, new RegExp(`→ ${join(cwd, `${ID_A}.trace.2.html`)} `));
  assert.equal(await readFile(first, 'utf8'), 'old');
  assert.deepEqual((await readdir(cwd)).sort(), [`${ID_A}.trace.1.html`, `${ID_A}.trace.2.html`, `${ID_A}.trace.html`]);
});

test('-o to an existing file writes <name>.1<ext>', async () => {
  await writeFile(join(cwd, 'x.html'), 'old');
  const { code, err } = await go([pathA, '-o', 'x.html']);
  assert.equal(code, 0);
  assert.match(err, /→ .*\/x\.1\.html /);
  assert.equal(await readFile(join(cwd, 'x.html'), 'utf8'), 'old');
});

test('a path relative to the cwd', async () => {
  await copyFile(FIXTURE, join(cwd, 'mine.jsonl'));
  const { code, err } = await go(['mine.jsonl']);
  assert.equal(code, 0);
  assert.ok(await exists(join(cwd, 'mine.trace.html')));
  assert.match(err, /mine\.trace\.html/);
});

test('an ID', async () => {
  const { code, err } = await go([ID_B]);
  assert.equal(code, 0);
  assert.ok(err.startsWith(pathB + '\n'));
  assert.ok(await exists(join(cwd, `${ID_B}.trace.html`)));
});

test('a unique ID prefix', async () => {
  const { code, err } = await go(['aaaa']);
  assert.equal(code, 0);
  assert.ok(err.startsWith(pathA + '\n'));
});

test('an unknown ID gives exit 1', async () => {
  const { code, out, err } = await go(['zzzz9999']);
  assert.equal(code, 1);
  assert.equal(out, '');
  assert.equal(err, 'yast: no session file or ID "zzzz9999"\n');
  assert.deepEqual(await readdir(cwd), []);
});

test('an ambiguous ID prefix lists the candidates and gives exit 1', async () => {
  const other = join(profile, 'projects', '-work-app', 'aaaa1111-ffff-0000-0000-000000000009.jsonl');
  await copyFile(FIXTURE, other);
  try {
    const { code, err } = await go(['aaaa']);
    assert.equal(code, 1);
    assert.match(err, /ambiguous/);
    assert.ok(err.includes(pathA) && err.includes(other));
    assert.deepEqual(await readdir(cwd), []);
  } finally {
    await rm(other);
  }
});

// ------------------------------------------------------------ rules 2-5: no session given

test('--list prints the sessions to stdout, newest first, and exits 0', async () => {
  const { code, out, err } = await go(['--list']);
  assert.equal(code, 0);
  assert.equal(err, '');
  const lines = out.trimEnd().split('\n');
  assert.equal(lines.length, 2);
  assert.match(lines[0] ?? '', /^1 {2}\d{4}-\d\d-\d\d \d\d:\d\d {2}\/work\/app {2}write tests in the packages\/apps directory$/);
  assert.match(lines[1] ?? '', /^2 /);
  assert.deepEqual(await readdir(cwd), []);
});

test('--list --limit 1 lists one session', async () => {
  const { code, out } = await go(['-l', '-n', '1']);
  assert.equal(code, 0);
  assert.equal(out.trimEnd().split('\n').length, 1);
});

test('interactive: a number picks the session', async () => {
  const { code, out, err } = await go([], { interactive: true, input: '2\n' });
  assert.equal(code, 0);
  assert.equal(out, '');
  assert.match(err, /^1 {2}\d{4}/); // the list goes to stderr first
  assert.ok(err.includes(`${pathA}\n→ `));
  assert.ok(await exists(join(cwd, `${ID_A}.trace.html`)));
});

test('interactive: an empty line picks the first session', async () => {
  const { code, err } = await go([], { interactive: true, input: '\n' });
  assert.equal(code, 0);
  assert.ok(err.includes(`${pathB}\n→ `));
  assert.ok(await exists(join(cwd, `${ID_B}.trace.html`)));
});

test('interactive: q returns 130 and writes nothing', async () => {
  const { code, out } = await go([], { interactive: true, input: 'q\n' });
  assert.equal(code, 130);
  assert.equal(out, '');
  assert.deepEqual(await readdir(cwd), []);
});

test('interactive: the end of input returns 130 and writes nothing', async () => {
  const { code, out } = await go([], { interactive: true, input: '' });
  assert.equal(code, 130);
  assert.equal(out, '');
  assert.deepEqual(await readdir(cwd), []);
});

test('interactive: a wrong answer asks again, then a number picks', async () => {
  const { code, err } = await go([], { interactive: true, input: 'abc\n9\n2\n' });
  assert.equal(code, 0);
  assert.equal(err.match(/is not a session number/g)?.length, 2);
  assert.ok(err.includes(`${pathA}\n→ `));
});

test('interactive: three wrong answers give exit 2', async () => {
  const { code, out, err } = await go([], { interactive: true, input: 'a\nb\n0\n1\n' });
  assert.equal(code, 2);
  assert.equal(out, '');
  assert.match(err, /yast: no valid session number\nTry "yast --help"\.\n$/);
  assert.deepEqual(await readdir(cwd), []);
});

test('not interactive without a session: the list to stdout, a hint to stderr, exit 2', async () => {
  const { code, out, err } = await go([]);
  assert.equal(code, 2);
  assert.equal(out.trimEnd().split('\n').length, 2);
  assert.equal(err, 'yast: pass a session path or ID\n');
  assert.deepEqual(await readdir(cwd), []);
});

test('an empty profile gives exit 1', async () => {
  const empty = join(tmp, 'empty-profile');
  await mkdir(empty);
  for (const argv of [[], ['--list']]) {
    for (const interactive of [false, true]) {
      const { code, out, err } = await go(argv, { config: empty, interactive });
      assert.equal(code, 1);
      assert.equal(out, '');
      assert.equal(err, `yast: no sessions in ${join(empty, 'projects')}\n`);
    }
  }
});

// ------------------------------------------------------------ rule 6: output

test('-o writes to the file, relative to the cwd', async () => {
  const { code, err } = await go([pathA, '-o', 'x.html']);
  assert.equal(code, 0);
  assert.equal(err, `${pathA}\n→ ${join(cwd, 'x.html')}  (${GOLDEN_COUNT} steps, 6 loop turns)\n`);
  assert.ok(await exists(join(cwd, 'x.html')));
  assert.ok(!(await exists(join(cwd, `${ID_A}.trace.html`))));
});

test('-o with an absolute path', async () => {
  const target = join(tmp, 'abs.html');
  const { code } = await go([pathA, '--output', target]);
  assert.equal(code, 0);
  assert.ok(await exists(target));
});

test('--stdout writes the page to stdout and no file', async () => {
  const { code, out, err } = await go([pathA, '--stdout']);
  assert.equal(code, 0);
  assert.equal(err, '');
  assert.ok(out.startsWith('<!doctype html>'));
  assert.deepEqual(await readdir(cwd), []);
});

test('-o with --stdout is a usage error', async () => {
  const { code, out, err } = await go([pathA, '-o', 'x.html', '--stdout']);
  assert.equal(code, 2);
  assert.equal(out, '');
  assert.match(err, /^yast: .*\nTry "yast --help"\.\n$/);
});

test('an unknown option is a usage error', async () => {
  const { code, err } = await go(['--nope']);
  assert.equal(code, 2);
  assert.match(err, /unknown option "--nope"\nTry "yast --help"\.\n$/);
});

test('the page holds the steps of the golden file', async () => {
  const { out } = await go([pathA, '--stdout']);
  const data = pageData(out);
  assert.deepEqual(data.steps, GOLDEN);
  assert.equal(data.meta.turns, 6);
  assert.equal(data.meta.file, `${ID_A}.jsonl`);
  const written = await go([pathA]);
  assert.equal(written.code, 0);
  assert.deepEqual(pageData(await readFile(join(cwd, `${ID_A}.trace.html`), 'utf8')).steps, GOLDEN);
});

test('--format claude-code works', async () => {
  const { code, out } = await go([pathA, '--format', 'claude-code', '--stdout']);
  assert.equal(code, 0);
  assert.deepEqual(pageData(out).steps, GOLDEN);
});

test('--format nope is a usage error', async () => {
  const { code, out, err } = await go([pathA, '--format', 'nope']);
  assert.equal(code, 2);
  assert.equal(out, '');
  assert.match(err, /unknown format "nope" \(known: claude-code\)\nTry "yast --help"\.\n$/);
  assert.deepEqual(await readdir(cwd), []);
});

test('the page uses the timeline turn content by default', async () => {
  const { code, out } = await go([pathA, '--stdout']);
  assert.equal(code, 0);
  assert.ok(out.includes('<!-- Turn content: timeline.'));
});

test('--turn-content inspector selects the inspector fragment', async () => {
  const { code, out } = await go([pathA, '--turn-content', 'inspector', '--stdout']);
  assert.equal(code, 0);
  assert.ok(out.includes('<!-- Turn content: inspector.'));
  assert.ok(!out.includes('<!-- Turn content: timeline.'));
});

test('--turn-content nope is a usage error', async () => {
  const { code, out, err } = await go([pathA, '--turn-content', 'nope']);
  assert.equal(code, 2);
  assert.equal(out, '');
  assert.match(err, /unknown turn content "nope" \(known: timeline, inspector\)\nTry "yast --help"\.\n$/);
  assert.deepEqual(await readdir(cwd), []);
});

test('a file that no format matches gives exit 1', async () => {
  await writeFile(join(cwd, 'notes.txt'), 'hello\n');
  const { code, out, err } = await go(['notes.txt']);
  assert.equal(code, 1);
  assert.equal(out, '');
  assert.match(err, /^yast: no known format matches notes\.txt\n$/);
});

// ------------------------------------------------------------ help and version

test('--help prints the usage to stdout and exits 0', async () => {
  const { code, out, err } = await go(['--help']);
  assert.equal(code, 0);
  assert.equal(err, '');
  assert.match(out, /^usage: yast/);
  assert.match(out, /claude-code/);
});

test('--version prints the version of package.json', async () => {
  const { code, out } = await go(['-v']);
  assert.equal(code, 0);
  assert.equal(out, packageVersion() + '\n');
});
