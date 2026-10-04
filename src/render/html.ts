// View → HTML. Renders one self-contained page from a View. Knows no log format.

import { readFileSync } from 'node:fs';
import type { View } from '../view/steps.js';

/** The turn-content fragments, by id. Each one is `fragment/turn-content/<id>.html`. */
export const TURN_CONTENTS = ['timeline', 'inspector'] as const;
export type TurnContent = (typeof TURN_CONTENTS)[number];
export const DEFAULT_TURN_CONTENT: TurnContent = 'timeline';

export const isTurnContent = (id: string): id is TurnContent => TURN_CONTENTS.some((x) => x === id);

// The .html files are not compiled. The build copies them next to this module, so
// the same paths work from src/ and from dist/ (see scripts/dist.mjs).
const read = (path: string): string => readFileSync(new URL(path, import.meta.url), 'utf8');
const PAGE = read('./page.html');
const FRAGMENTS: Readonly<Record<TurnContent, string>> = {
  timeline: read('./fragment/turn-content/timeline.html'),
  inspector: read('./fragment/turn-content/inspector.html'),
};

export type RenderOptions = {
  /** The fragment that renders the article of a step. Default: `DEFAULT_TURN_CONTENT`. */
  readonly turnContent?: TurnContent;
};

const escapeHtml = (s: string): string =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export function renderHtml(view: View, options: RenderOptions = {}): string {
  const json = JSON.stringify(view)
    .replace(/</g, '\\u003c')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
  const name = escapeHtml(view.meta.harnessName || 'Agent');
  const article = FRAGMENTS[options.turnContent ?? DEFAULT_TURN_CONTENT];
  // One pass: the inserted text is not scanned again for placeholders.
  return PAGE.replace(/\/\*__(HARNESS|DATA)__\*\/|<!--__(ARTICLE)__-->/g, (_, a: string | undefined, b: string | undefined) =>
    (a ?? b) === 'DATA' ? json : (a ?? b) === 'ARTICLE' ? article : name,
  );
}
