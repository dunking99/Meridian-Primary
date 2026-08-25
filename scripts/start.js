// Cross-platform launcher for Meridian (API + UI).
//
// Node is spawned WITHOUT a shell. Passing shell:true splits arguments on
// spaces, which breaks on Windows where node lives under "C:\Program Files"
// — the shell tries to run a program called C:\Program and fails.
// npm on Windows is a .cmd file and genuinely does need a shell, so the two
// are launched differently on purpose.

import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const procs = [];
let stopping = false;

// OneDrive keeps handles open on files it is syncing. When that happens to a
// file Node is importing or Vite is rewriting, Windows returns EPERM and the
// server dies — the symptom being an apparently random lock on whichever
// module was unlucky. Vite's own cache has been moved out of the folder (see
// vite.config.js), but a synced project folder can still stall an import, so
// say so plainly on startup rather than leaving it to be rediscovered.
function warnIfSynced() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const match = /OneDrive|Dropbox|Google Drive|iCloudDrive/i.exec(root);
  if (!match) return;
  console.log(`  ! This project sits inside a ${match[0]} folder:`);
  console.log(`      ${root}`);
  console.log('    Sync clients hold file locks that surface as EPERM crashes.');
  console.log('    Either move the project outside the synced folder (recommended),');
  console.log(`    or exclude it from syncing in the ${match[0]} settings.\n`);
}

function launch(name, cmd, args, useShell) {
  const p = spawn(cmd, args, { stdio: 'inherit', shell: useShell });
  p.on('error', e => { console.log(`[${name}] failed to start: ${e.message}`); shutdown(); });
  p.on('exit', code => {
    if (stopping) return;
    console.log(`\n[${name}] exited with code ${code}`);
    shutdown();
  });
  procs.push(p);
}

function shutdown() {
  if (stopping) return;
  stopping = true;
  for (const p of procs) { try { p.kill(); } catch {} }
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

console.log('Starting Meridian (API + UI). Press Ctrl+C to stop both.\n');
warnIfSynced();

launch('api', process.execPath, ['server/index.js'], false);

const isWin = process.platform === 'win32';
setTimeout(() => launch('ui', isWin ? 'npm.cmd' : 'npm', ['run', 'dev'], isWin), 1500);
