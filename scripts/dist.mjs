// The two steps of the build that tsc does not do. `npm run build` runs them around tsc:
//
//   node scripts/dist.mjs clean    remove dist/, so that no file of an old build stays (and runs as a test)
//   node scripts/dist.mjs assets   copy the files that tsc does not copy (src/render/page.html and src/render/fragment/)
//
// A plain Node script, so that it runs the same on every platform.
import { cpSync, rmSync } from 'node:fs';

const root = new URL('../', import.meta.url);
const step = process.argv[2];

if (step === 'clean') {
  rmSync(new URL('dist/', root), { recursive: true, force: true });
} else if (step === 'assets') {
  // The renderer reads page.html and the fragments at run time, next to its own module.
  cpSync(new URL('src/render/page.html', root), new URL('dist/src/render/page.html', root));
  cpSync(new URL('src/render/fragment/', root), new URL('dist/src/render/fragment/', root), { recursive: true });
} else {
  console.error('usage: node scripts/dist.mjs clean|assets');
  process.exit(2);
}
