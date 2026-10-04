// Read the data block of a rendered page.
import assert from 'node:assert/strict';

export type PageData = {
  readonly meta: { readonly [key: string]: unknown };
  readonly steps: readonly { readonly [key: string]: unknown }[];
  /** One entry per step: an object for a request step, else null. */
  readonly details: readonly unknown[];
};

const isRec = (x: unknown): x is { readonly [key: string]: unknown } => typeof x === 'object' && x !== null && !Array.isArray(x);

export function pageData(html: string): PageData {
  const m = html.match(/<script type="application\/json" id="data">([\s\S]*?)<\/script>/);
  assert.ok(m?.[1], 'data block exists');
  const data: unknown = JSON.parse(m[1]);
  assert.ok(isRec(data) && isRec(data.meta) && Array.isArray(data.steps) && data.steps.every(isRec), 'data block has meta and steps');
  assert.ok(Array.isArray(data.details) && data.details.length === data.steps.length, 'data block has one detail per step');
  const steps: readonly { readonly [key: string]: unknown }[] = data.steps;
  const details: readonly unknown[] = data.details;
  return { meta: data.meta, steps, details };
}
