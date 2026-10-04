// The CLI: argv + io → exit code. The only module that joins sources, formats, view and render.

import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { formats, getFormat, parseSession, UnknownFormatError } from '../formats/index.js';
import { sources } from '../sources/index.js';
import type { SessionInfo } from '../sources/index.js';
import { toView } from '../view/steps.js';
import type { View } from '../view/steps.js';
import { DEFAULT_TURN_CONTENT, isTurnContent, renderHtml, TURN_CONTENTS } from '../render/html.js';
import { parseArgs, helpText, UsageError } from './args.js';
import type { ListArgs, TraceArgs } from './args.js';
import { formatSessionList } from './list.js';
import { pickSession } from './pick.js';

type Writer = { readonly write: (s: string) => unknown };

export type IO = {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly home: string;
  readonly cwd: string;
  readonly stdin: NodeJS.ReadableStream;
  readonly stdout: Writer;
  readonly stderr: Writer;
  /** stdin and stderr are a terminal. */
  readonly interactive: boolean;
  /** Terminal width, when known. */
  readonly columns?: number | undefined;
};

/** Invariant 9: the exit codes. */
export type ExitCode = 0 | 1 | 2 | 130;

const EXIT = {
  ok: 0,
  error: 1,
  usage: 2,
  interrupted: 130,
} as const satisfies Readonly<Record<string, ExitCode>>;

const NAME = 'yast';

/**
 * @param argv  the arguments after the script name
 * @returns the exit code
 */
export async function run(argv: readonly string[], io: IO): Promise<ExitCode> {
  try {
    const args = parseArgs(argv);
    if (args.mode === 'help') {
      io.stdout.write(helpText(formats.map((f) => f.id), TURN_CONTENTS, DEFAULT_TURN_CONTENT));
      return EXIT.ok;
    }
    if (args.mode === 'version') {
      io.stdout.write(version() + '\n');
      return EXIT.ok;
    }
    if (args.format !== undefined && !getFormat(args.format)) {
      throw new UsageError(`unknown format "${args.format}" (known: ${formats.map((f) => f.id).join(', ')})`);
    }
    if (args.mode === 'trace' && args.turnContent !== undefined && !isTurnContent(args.turnContent)) {
      throw new UsageError(`unknown turn content "${args.turnContent}" (known: ${TURN_CONTENTS.join(', ')})`);
    }
    return await execute(args, io);
  } catch (e) {
    if (e instanceof UsageError) {
      io.stderr.write(`${NAME}: ${e.message}\nTry "${NAME} --help".\n`);
      return EXIT.usage;
    }
    io.stderr.write(`${NAME}: ${e instanceof Error ? e.message : String(e)}\n`);
    return EXIT.error;
  }
}

/** The version in package.json. The file is next to bin/ and src/ (or dist/): look upward for it. */
function version(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  while (!existsSync(join(dir, 'package.json'))) {
    const parent = dirname(dir);
    if (parent === dir) throw new Error('package.json not found');
    dir = parent;
  }
  const pkg: unknown = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
  return typeof pkg === 'object' && pkg !== null && 'version' in pkg ? String(pkg.version) : 'undefined';
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/**
 * Write `text` to `path`, or, when `path` exists, to the first free `<name>.N<ext>`
 * (N = 1, 2, …). The `wx` flag makes the check and the write one step.
 * @returns the path that the function writes
 */
function writeNew(path: string, text: string): string {
  const ext = extname(path);
  const stem = path.slice(0, path.length - ext.length);
  for (let n = 0; ; n++) {
    const target = n === 0 ? path : `${stem}.${n}${ext}`;
    try {
      writeFileSync(target, text, { flag: 'wx' });
      return target;
    } catch (e) {
      if (!(e instanceof Error && 'code' in e && e.code === 'EEXIST')) throw e;
    }
  }
}

const isNonEmpty = <T>(items: readonly T[]): items is readonly [T, ...T[]] => items.length > 0;

/** @returns absolute path of the session file */
async function findSession(arg: string, io: IO): Promise<string | null> {
  const direct = resolve(io.cwd, arg);
  if (isFile(direct)) return direct;
  for (const source of sources) {
    const hit = await source.resolve(source.root(io.env, io.home), arg);
    if (hit) return hit;
  }
  return null;
}

/** All sessions of all sources, newest first. */
async function listSessions(io: IO, limit: number): Promise<SessionInfo[]> {
  const all: SessionInfo[] = [];
  for (const source of sources) all.push(...(await source.list(source.root(io.env, io.home), { limit })));
  return all.sort((a, b) => b.modifiedAt.getTime() - a.modifiedAt.getTime()).slice(0, limit);
}

const projectsDirs = (io: IO): string => sources.map((s) => join(s.root(io.env, io.home), 'projects')).join(', ');

async function execute(args: ListArgs | TraceArgs, io: IO): Promise<ExitCode> {
  if (args.mode === 'trace' && args.session !== undefined) {
    const file = await findSession(args.session, io);
    if (!file) {
      io.stderr.write(`${NAME}: no session file or ID "${args.session}"\n`);
      return EXIT.error;
    }
    return trace(file, args, io);
  }

  const sessions = await listSessions(io, args.limit);
  if (!isNonEmpty(sessions)) {
    io.stderr.write(`${NAME}: no sessions in ${projectsDirs(io)}\n`);
    return EXIT.error;
  }
  const table = formatSessionList(sessions, { columns: io.columns });
  if (args.mode === 'list') {
    io.stdout.write(table);
    return EXIT.ok;
  }
  if (!io.interactive) {
    io.stdout.write(table);
    io.stderr.write(`${NAME}: pass a session path or ID\n`);
    return EXIT.usage;
  }
  io.stderr.write(table);
  const picked = await pickSession(sessions, io);
  if (!picked) return EXIT.interrupted;
  return trace(picked.path, args, io);
}

/** @param file absolute path of the session log */
async function trace(file: string, args: TraceArgs, io: IO): Promise<ExitCode> {
  const text = readFileSync(file, 'utf8');
  let view: View;
  try {
    view = toView(parseSession(text, { file: basename(file), format: args.format }));
  } catch (e) {
    if (e instanceof UnknownFormatError) {
      io.stderr.write(`${NAME}: ${e.message}\n`);
      return EXIT.error;
    }
    throw e;
  }
  const turnContent = args.turnContent !== undefined && isTurnContent(args.turnContent) ? args.turnContent : DEFAULT_TURN_CONTENT;
  const html = renderHtml(view, { turnContent });

  const target = args.output;
  if (target.kind === 'stdout') {
    io.stdout.write(html);
    return EXIT.ok;
  }
  const out = target.kind === 'file' ? resolve(io.cwd, target.path) : join(io.cwd, `${basename(file, '.jsonl')}.trace.html`);
  const written = writeNew(out, html);
  io.stderr.write(`${file}\n→ ${written}  (${view.steps.length} steps, ${view.meta.turns} loop turns)\n`);
  return EXIT.ok;
}
