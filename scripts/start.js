// Cross-platform launcher for Meridian (API + UI).
//
// Node is spawned WITHOUT a shell. Passing shell:true splits arguments on
// spaces, which breaks on Windows where node lives under "C:\Program Files"
// — the shell tries to run a program called C:\Program and fails.
// npm on Windows is a .cmd file and genuinely does need a shell, so the two
// are launched differently on purpose.

import { spawn } from 'child_process';

const procs = [];
let stopping = false;

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

launch('api', process.execPath, ['server/index.js'], false);

const isWin = process.platform === 'win32';
setTimeout(() => launch('ui', isWin ? 'npm.cmd' : 'npm', ['run', 'dev'], isWin), 1500);
