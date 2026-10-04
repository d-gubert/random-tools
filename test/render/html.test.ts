import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toView, type Step, type View } from '../../src/view/steps.js';
import { renderHtml, TURN_CONTENTS } from '../../src/render/html.js';
import { readGoldenSession } from '../support/golden.js';
import { pageData } from '../support/page.js';

const session = readGoldenSession();

/** The view with the first step changed. */
function withFirstStep(view: View, patch: Partial<Pick<Step, 't' | 'd'>>): View {
  return { ...view, steps: view.steps.map((s, i) => (i === 0 ? { ...s, ...patch } : s)) };
}

test('the data block holds the step titles', () => {
  const view = toView(session);
  const html = renderHtml(view);
  const data = pageData(html);
  assert.deepEqual(data, JSON.parse(JSON.stringify(view)));
  for (const s of view.steps) assert.ok(html.includes(JSON.stringify(s.t).slice(1, -1)), s.t);
  assert.ok(html.startsWith('<!doctype html>'));
});

test('a harness name shows in the title, the h1, and the data', () => {
  const html = renderHtml(toView({ ...session, meta: { ...session.meta, harnessName: 'Other Agent' } }));
  assert.match(html, /<title>Other Agent Session Trace<\/title>/);
  assert.match(html, /<h1>Other Agent session trace<\/h1>/);
  assert.equal(pageData(html).meta.harnessName, 'Other Agent');
  assert.doesNotMatch(html.replace(/"[^"]*Claude Code[^"]*"/g, ''), /<h1>Claude Code/);
});

test('the harness name is HTML-escaped', () => {
  const html = renderHtml(toView({ ...session, meta: { ...session.meta, harnessName: '<b>"x"</b>' } }));
  assert.match(html, /<h1>&lt;b&gt;&quot;x&quot;&lt;\/b&gt; session trace<\/h1>/);
});

test('a script end tag in a step title does not end the data script', () => {
  const view = withFirstStep(toView(session), { t: '</script><script>alert(1)</script>' });
  const html = renderHtml(view);
  // The fragment script, the data script, and the page script.
  assert.equal(html.split('</script>').length - 1, 3);
  assert.equal(pageData(html).steps[0]?.t, '</script><script>alert(1)</script>');
});

test('U+2028 and U+2029 are escaped in the data', () => {
  const view = withFirstStep(toView(session), { d: 'a\u2028b\u2029c' });
  const html = renderHtml(view);
  assert.ok(!html.includes('\u2028'));
  assert.ok(!html.includes('\u2029'));
  assert.ok(html.includes('a\\u2028b\\u2029c'));
  assert.equal(pageData(html).steps[0]?.d, 'a\u2028b\u2029c');
});

test('replacement text with $ patterns is kept as is', () => {
  const view = withFirstStep(toView(session), { d: "cost $& $' $1" });
  assert.equal(pageData(renderHtml(view)).steps[0]?.d, "cost $& $' $1");
});

test('each turn content puts its fragment in place of the article', () => {
  const view = toView(session);
  for (const id of TURN_CONTENTS) {
    const html = renderHtml(view, { turnContent: id });
    assert.ok(html.includes(`<!-- Turn content: ${id}.`), id);
    assert.ok(html.includes('id="turn-card"'), id);
    assert.ok(html.includes('window.renderTurn='), id);
    assert.doesNotMatch(html, /<!--__ARTICLE__-->|\/\*__(DATA|HARNESS)__\*\//, id);
    assert.equal(html.match(/id="turn-card"/g)?.length, 1, id);
  }
  assert.ok(renderHtml(view).includes('<!-- Turn content: timeline.'));
});

test('a placeholder in the data is not replaced', () => {
  const view = withFirstStep(toView(session), { d: '<!--__ARTICLE__--> /*__HARNESS__*/' });
  assert.equal(pageData(renderHtml(view)).steps[0]?.d, '<!--__ARTICLE__--> /*__HARNESS__*/');
});
