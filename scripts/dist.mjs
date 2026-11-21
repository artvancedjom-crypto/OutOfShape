// One-command Windows packaging.
//   node scripts/dist.mjs portable    → release/OutOfShape-Lab-<version>-win-x64-portable.exe + .zip
//   node scripts/dist.mjs installer   → release/OutOfShape-Lab-<version>-win-x64-setup.exe
//   node scripts/dist.mjs all         → all three
// Extra flag: --skip-web  reuse the existing dist/ instead of running `vite build` again.
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { builderConfig } from './builder-config.mjs';

const require = createRequire(import.meta.url);
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(root);

const args = process.argv.slice(2);
const what = args.find((a) => !a.startsWith('-')) || 'all';
if (!['portable', 'installer', 'all'].includes(what)) {
  console.error('Usage: node scripts/dist.mjs [portable|installer|all] [--skip-web]');
  process.exit(1);
}
const variants = what === 'all' ? ['portable', 'installer'] : [what];
const release = join(root, 'release');
const step = (msg) => console.log(`\n\x1b[36m▶ ${msg}\x1b[0m`);

// 1. Web build (also copies the PDF.js assets through the "prebuild" script)
if (!args.includes('--skip-web')) {
  step('Building the web app (vite build)');
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const r = spawnSync(npm, ['run', 'build'], { stdio: 'inherit', shell: process.platform === 'win32' });
  if (r.status !== 0) process.exit(r.status || 1);
}
if (!existsSync(join(root, 'dist', 'index.html'))) {
  console.error('dist/index.html is missing. Run without --skip-web.');
  process.exit(1);
}
for (const f of ['pdfjs/cmaps', 'pdfjs/standard_fonts', 'assets']) {
  if (!existsSync(join(root, 'dist', f))) {
    console.error(`dist/${f} is missing: the build is incomplete (did "npm run build" finish?).`);
    process.exit(1);
  }
}

// 2. Can we write icon + version info into the .exe? Always on Windows; elsewhere only with Wine.
let editExecutable = true;
if (process.platform !== 'win32') {
  try {
    execFileSync('wine', ['--version'], { stdio: 'ignore' });
  } catch {
    editExecutable = false;
    console.warn('\x1b[33m! Cross-building without Wine: the .exe keeps the default Electron icon and version info.\n  Build on Windows for release artifacts.\x1b[0m');
  }
}

if (!editExecutable && variants.includes('installer')) {
  if (what === 'installer') {
    console.error('The installer cannot be built on this system: electron-builder needs Wine to create the uninstaller.\nBuild on Windows, or install Wine.');
    process.exit(1);
  }
  console.warn('\x1b[33m! Skipping the installer: it needs Wine on non-Windows systems. Building the portable files only.\x1b[0m');
  variants.splice(variants.indexOf('installer'), 1);
}

// 3. Package
const { build, Platform, Arch } = require('electron-builder');
mkdirSync(release, { recursive: true });
const produced = [];
for (const variant of variants) {
  const outDir = join(release, `.build-${variant}`);
  rmSync(outDir, { recursive: true, force: true });
  const targets = variant === 'portable' ? ['portable', 'zip'] : ['nsis'];
  step(`Packaging ${variant} (${targets.join(' + ')})`);
  await build({
    targets: Platform.WINDOWS.createTarget(targets, Arch.x64),
    config: builderConfig(variant, { outDir, editExecutable }),
    publish: 'never',
  });
  for (const f of readdirSync(outDir)) {
    if (!/\.(exe|zip)$/i.test(f) || f.startsWith('__uninstaller')) continue;
    copyFileSync(join(outDir, f), join(release, f));
    produced.push(f);
  }
  rmSync(outDir, { recursive: true, force: true });
}

// 4. Checksums + summary
const lines = [];
for (const f of readdirSync(release).filter((x) => /\.(exe|zip)$/i.test(x)).sort()) {
  lines.push(`${createHash('sha256').update(readFileSync(join(release, f))).digest('hex')}  ${f}`);
}
writeFileSync(join(release, 'SHA256SUMS.txt'), lines.join('\n') + '\n');
step('Done. Files in release/:');
for (const f of produced) console.log(`  ${f.padEnd(52)} ${(statSync(join(release, f)).size / 1048576).toFixed(1)} MB`);
console.log('  SHA256SUMS.txt');
