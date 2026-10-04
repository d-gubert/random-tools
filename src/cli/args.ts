// Command-line parsing. Knows no other module.

export const DEFAULT_LIMIT = 20;

/** Where `trace` writes the page. Invariant 8: `-o` with `--stdout` has no representation. */
export type OutputTarget =
  | { readonly kind: 'stdout' }
  | { readonly kind: 'file'; readonly path: string }
  | { readonly kind: 'default' };

/** `-h, --help` */
export type HelpArgs = { readonly mode: 'help' };

/** `-v, --version` */
export type VersionArgs = { readonly mode: 'version' };

/** `-l, --list`. It has no session and no output target. */
export type ListArgs = {
  readonly mode: 'list';
  readonly limit: number;
  /** Format id. */
  readonly format?: string;
};

/** The default mode: make the page of one session. */
export type TraceArgs = {
  readonly mode: 'trace';
  /** Path, session ID, or ID prefix. Without it, the tool lists the sessions and lets the user pick. */
  readonly session?: string;
  readonly output: OutputTarget;
  /** Format id. */
  readonly format?: string;
  /** Number of sessions in the picker list. */
  readonly limit: number;
  /** Turn-content fragment id. Without it, the renderer uses its default. */
  readonly turnContent?: string;
};

/** Invariant 8: the arguments are one of four modes. */
export type Args = HelpArgs | VersionArgs | ListArgs | TraceArgs;

export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UsageError';
  }
}

type FlagName = 'output' | 'stdout' | 'format' | 'turnContent' | 'list' | 'limit' | 'help' | 'version';

const LONG: Readonly<Record<string, FlagName>> = {
  '--output': 'output',
  '--stdout': 'stdout',
  '--format': 'format',
  '--turn-content': 'turnContent',
  '--list': 'list',
  '--limit': 'limit',
  '--help': 'help',
  '--version': 'version',
};
const SHORT: Readonly<Record<string, FlagName>> = { '-o': 'output', '-f': 'format', '-l': 'list', '-n': 'limit', '-h': 'help', '-v': 'version' };

/**
 * @param argv  the arguments after the script name
 * @throws {UsageError}
 */
export function parseArgs(argv: readonly string[]): Args {
  let session: string | undefined;
  let output: string | undefined;
  let stdout = false;
  let format: string | undefined;
  let turnContent: string | undefined;
  let list = false;
  let limit = DEFAULT_LIMIT;
  let help = false;
  let version = false;
  let optionsEnded = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? '';
    if (optionsEnded || arg === '-' || !arg.startsWith('-')) {
      if (session !== undefined) throw new UsageError(`unexpected argument "${arg}"`);
      session = arg;
      continue;
    }
    if (arg === '--') {
      optionsEnded = true;
      continue;
    }

    let flag = arg;
    let inline: string | undefined;
    const eq = arg.startsWith('--') ? arg.indexOf('=') : -1;
    if (eq > 0) {
      flag = arg.slice(0, eq);
      inline = arg.slice(eq + 1);
    }
    const name = LONG[flag] ?? SHORT[flag];
    if (!name) throw new UsageError(`unknown option "${flag}"`);

    if (name === 'stdout' || name === 'list' || name === 'help' || name === 'version') {
      if (inline !== undefined) throw new UsageError(`option ${flag} takes no value`);
      if (name === 'stdout') stdout = true;
      else if (name === 'list') list = true;
      else if (name === 'help') help = true;
      else version = true;
      continue;
    }

    let value = inline;
    if (value === undefined) {
      const next = argv[i + 1];
      if (next === undefined || (next.startsWith('-') && next !== '-')) throw new UsageError(`option ${flag} needs a value`);
      value = next;
      i++;
    }
    if (name === 'limit') {
      if (!/^[1-9]\d*$/.test(value)) throw new UsageError(`invalid number for ${flag}: "${value}"`);
      limit = Number(value);
    } else if (name === 'output') output = value;
    else if (name === 'turnContent') turnContent = value;
    else format = value;
  }

  if (output !== undefined && stdout) throw new UsageError('-o/--output and --stdout cannot be used together');
  if (list && (session !== undefined || output !== undefined || stdout || turnContent !== undefined)) {
    throw new UsageError('--list cannot be used with a session, -o/--output, --stdout, or --turn-content');
  }

  if (help) return { mode: 'help' };
  if (version) return { mode: 'version' };
  const withFormat = format === undefined ? {} : { format };
  if (list) return { mode: 'list', limit, ...withFormat };
  const target: OutputTarget = stdout ? { kind: 'stdout' } : output !== undefined ? { kind: 'file', path: output } : { kind: 'default' };
  return {
    mode: 'trace',
    output: target,
    limit,
    ...withFormat,
    ...(turnContent === undefined ? {} : { turnContent }),
    ...(session === undefined ? {} : { session }),
  };
}

/**
 * @param formatIds        the ids of the log formats
 * @param turnContents     the ids of the turn-content fragments
 * @param turnDefault      the id that the renderer uses without --turn-content
 */
export function helpText(formatIds: readonly string[], turnContents: readonly string[] = [], turnDefault: string = turnContents[0] ?? ''): string {
  return `usage: yast [options] [session]

  session            path to a session log, or a session ID (or a unique ID prefix)
  -o, --output FILE  write the page to FILE
      --stdout       write the page to stdout
  -f, --format ID    log format; default: detect (${formatIds.join(', ')})
  --turn-content ID  how the page shows a loop turn: ${turnContents.join(', ')}; default: ${turnDefault}
  -l, --list         list the sessions and exit
  -n, --limit N      number of sessions in the list (default ${DEFAULT_LIMIT})
  -h, --help         show this help
  -v, --version      show the version
`;
}
