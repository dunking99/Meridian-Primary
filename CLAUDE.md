# Meridian — orientation for Claude

Read this first, every session. It's the context a new session otherwise has
to be given by hand.

## What this is

A personal, local, single-user markets terminal for hugodyson345@gmail.com.
Node/Express-ish backend (`server/`) with SQLite via `node:sqlite`, React
frontend (`src/App.jsx`, one large file). No auth, no multi-tenancy, no
deployment — it runs on the user's own machine and nowhere else.

Full architecture, engines, endpoints and design principles are documented in
`README.md` — read that for technical depth. This file is about the parts a
README can't capture: how this specific user works, and the infrastructure
built to support that.

## The user

Not a developer. Works entirely through GitHub (via you) and a PowerShell
terminal on their own machine, copying commands you give them. Wants direct,
short answers — no hedging, no over-explaining, no "let me just double check"
theatre. Gets (rightly) frustrated by fixes that turn out to be unverified
guesses. **Verify things for real before claiming they work** — this has
mattered concretely more than once in this project's history (see "Testing
discipline" below).

## Repo, branch, and where it actually runs

- GitHub: `dunking99/Meridian-Primary`
- Everything merges into `main`. No long-lived feature branches — branch,
  commit, push, PR, merge, every time, for every change, without being asked.
  The user's machine only ever tracks `main`.
- The user's live machine is Windows, repo cloned at `C:\Meridian-Primary`.
  (There was earlier confusion involving a Mac and folders that were never
  actually `git clone`'d — resolved. If a session ever hits `fatal: not a git
  repository` from the user, that's this class of problem again: the folder
  exists but was never cloned, or was `.zip`-downloaded instead. Fix is a
  fresh `git clone`, not manual file copying.)

## The user's machine auto-updates itself — you don't need to tell them to pull

`scripts/windows/` (PowerShell) is a full auto-update system, already
installed and running via Windows Task Scheduler (`MeridianAutoUpdate`,
every 5 minutes + at login):

- Checks GitHub for a new commit on `main`.
- If there's one: backs up every file about to change into
  `_archive\<timestamp>\`, fast-forward pulls, runs `npm install` if
  `package.json` changed, restarts the app.
- If there's nothing new: makes sure the app is actually running, starts it
  if not.
- Logs everything to `auto-update.log` in the repo root.
- `restore-backup.ps1` rolls back to any previous backup on demand.
- `stop-auto-update.ps1` / re-running `setup-auto-update.ps1` disable/enable it.

**Practical effect: once you merge to `main`, the user's machine picks it up
within 5 minutes on its own.** You don't need to give pull instructions for
routine work. Only mention manual steps for something outside this loop
(first-time setup on a *new* machine, or the auto-update system itself being
broken).

## meridian.db — never touch, never assume

The user's real holdings, cash, and price history live in `meridian.db`
(+ `-shm`/`-wal`) in the repo root. It is:
- gitignored — never in git, never in a fresh clone, never touched by
  auto-update or by `git pull`.
- **the one thing in this whole project with no version history and no
  automatic backup.** If it's ever at risk (a script that might delete or
  regenerate it, a "let's start fresh" suggestion), stop and flag it rather
  than acting — there is no undo.
- On a new machine, it must be manually copied over from wherever the user's
  existing copy is before running the app for real.

## Testing discipline (why this matters here specifically)

This project has a real, demonstrated failure mode: shipping something that
passes every check available in the build/dev sandbox but breaks on the
user's actual machine, because the sandbox doesn't match it.

Two real incidents, both in `scripts/windows/*.ps1`:
1. A `.ps1` with an em-dash, saved as UTF-8 with no BOM, parsed fine under
   PowerShell 7 (`pwsh`, what's available in this environment) but threw a
   confusing "missing closing brace" under Windows PowerShell 5.1 — what
   Task Scheduler actually runs on the user's machine.
2. `git fetch`/`git pull` wrapped in try/catch with `$ErrorActionPreference
   = 'Stop'` silently treated git's own routine stderr status text as a
   failure — meaning auto-update was reporting failure on every successful
   run and never actually applying updates. Also didn't reproduce under
   `pwsh` in this sandbox.
3. The idle-check path unconditionally restarted the app whenever it wasn't
   listening on its port, even if the user had deliberately closed it and
   nothing had actually updated — combined with `-WindowStyle Hidden` on
   `powershell.exe`/`cmd.exe` being unreliable (both still briefly allocate a
   console before the hidden style applies), this meant a PowerShell window
   visibly flashed on screen every 5 minutes for no reason. Fixed by gating
   the idle-restart behind an explicit `-EnsureRunning` switch (only the
   login-time task passes it) and routing all launches through
   `wscript.exe` + `run-hidden.vbs`, which never allocates a console at all.
   The actual invisible-launch behavior couldn't be end-to-end verified in
   this sandbox (no real Windows/Task Scheduler available) — flagged as such
   rather than claimed as tested.

Lessons applied going forward, not just for these two bugs:
- For anything PowerShell: **fetch a real `pwsh` binary into the sandbox and
  run the actual file** (`[System.Management.Automation.Language.Parser]::
  ParseFile` for a syntax check, and a real throwaway git remote/clone for
  behavioral tests) rather than reasoning about it or testing only in a
  different interpreter than the target. This is unusually cheap to do —
  `pwsh` is a downloadable static binary and takes seconds to fetch — so
  there's no excuse to skip it.
- Native command (git, npm) success/failure must be checked via
  `$LASTEXITCODE`, never inferred from whether an exception was thrown or
  what got written to stderr.
- `.ps1` files: ASCII only. No em-dashes, no curly quotes, no Unicode
  punctuation. Windows PowerShell 5.1's BOM-less-UTF-8 handling is
  unreliable enough that this is a real, not theoretical, risk — plain
  ASCII sidesteps it entirely regardless of codepage.
- For the frontend: this environment can boot the real API + Vite dev server
  and drive it with Playwright — do that for anything UI-facing rather than
  reasoning about JSX from a distance. Yahoo/Google/SEC are blocked from
  this sandbox's network, so exercising live-fetch-dependent UI needs
  request interception with fixtures shaped exactly like the real response
  (see any recent commit touching Research tabs for the pattern).
- Say plainly when something is genuinely unverifiable here (e.g.
  `Register-ScheduledTask` itself, which needs a real Windows Task Scheduler)
  rather than implying full confidence.

## Working conventions established in this project

- Small, single-purpose commits, each with a substantial commit message
  explaining *why*, not just what — this repo's history is written to be
  read later, including by a future Claude session with no memory of this
  one.
- No fabricated/placeholder/mock data, ever, in anything user-facing —
  purging exactly this was most of the v3 rebuild. Missing data renders as
  visibly missing (a `NoData` component, explained gaps), never a plausible
  fake number.
- Every derived figure states its source and, where relevant, its
  provenance/freshness. This app's whole value proposition (see README) is
  measuring things against their own history rather than showing raw
  levels — don't undermine that with an unlabelled number.
- AI-generated commentary anywhere in the app must be able to conclude
  "nothing notable happened" — prompts are written accordingly. Don't
  loosen this to get more interesting-sounding output.
