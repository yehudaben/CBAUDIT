# CLAUDE.md — Chargeback Risk Console

Read this before changing anything. It records the rules the tool is built on,
the invariants that must not drift, and the traps that have already cost time.

## What this is

A single self-contained HTML file that turns a Paymenthelp portal export into a
ranked merchant chargeback risk audit. Yehuda (yehuda@paymenthelp.com) runs it
daily; a few colleagues may use the hosted copy.

- **The whole app is `public/index.html`.** All CSS, all JS, all scoring logic.
  No build step, no framework, no dependencies at runtime.
- All analysis is client-side. Report CSVs are read in the browser and never
  uploaded. With the filesystem backend the page makes exactly one network call
  in its life — its own `version.json`. **The Drive backend changes that claim
  and the claim must move with it**: it talks to `accounts.google.com` and
  `www.googleapis.com`. No report data goes anywhere it was not already (it is
  sitting in Google Drive), but "nothing leaves the browser" is only literally
  true on the filesystem route. Do not let the README drift back.
- Deployed on Cloudflare (Workers static assets) from this repo. A push to
  `main` is a deployment. Live at `cb.yehuda-ceb.workers.dev`.

## Hard rules

These come from the user directly and are not negotiable without asking.

1. **Never estimate and never fabricate a figure.** If a field is not in the
   portal, the output says "not available". This applies to the app's rendering
   and to anything you report in conversation.
2. **The 21-column audit export order is exact.** Tier, Flags, Primary, Action,
   Bucket, Merchant, DBA, MID, # Sales, $ Sales, CB #, CB Volume, CB %,
   $ Refunds, Refund %, MC, Visa, # RDR, RDR Coverage %, Amex, Disc. Thicker
   rules after Action, $ Sales, CB #, CB %, MC, RDR Coverage %. Do not add,
   remove or reorder columns here without being asked.
3. **`# Sales = 0` with `CB # > 0`** renders "no sales — data integrity flag",
   never a percentage. These rows are excluded from ranking entirely.
4. Percentages to one decimal, **CB % to two**, counts whole. Tables stay under
   ten columns where practical.

## Domain facts

- **Portal counters reset to zero on the 1st of each month.** Every figure is
  month-to-date — not daily, not lifetime. This is the single most important
  fact about the data and the source of the subtlest bugs. See below.
- **CB % is count-based**: `CB # ÷ # Sales`. Not dollar-based.
- **Refund % is dollar-based**: `$ Refunds ÷ $ Sales`. The two rates use
  different bases on purpose — that is what the portal reports.
- **RDR coverage** = `# RDR ÷ (# RDR + Visa CB)`. **MC share** = `MC CB ÷ total CB`.
- 2% CB is the card-brand monitoring ceiling. That is why F5 and the magnitude
  bonus are anchored there.

## The scoring model

Verified line by line against an independent re-derivation. **Do not change
weights or thresholds without being asked**, and re-run the full verification
if you do.

| Flag | Rule | Weight |
|---|---|---|
| F5 | CB % > 2 AND CB # ≥ 5 | 10 |
| F1 | Visa CB ≥ 5 AND (RDR = 0 OR coverage < 50%) | 4 |
| F3 | MC CB > 5 AND Refund % < 10% | 3 |
| F4 | Amex CB ≥ 5 OR Discover CB ≥ 5 | 2 |
| F2 | RDR = 0 AND Visa CB > 3 | 1 |

- **Magnitude bonus, F5 rows only:** CB % > 5 adds 6; CB % ≥ 3 adds 3; below
  that adds nothing. A row with CB % > 100 gets **no** bonus — bad data must
  never outrank real damage.
- **Tiers:** weighted ≥ 16 = ACT TODAY, ≥ 10 = HIGH, 1–9 = MONITOR.
  `bad` (CB % > 100) = QUARANTINE. `zs` (zero sales, chargebacks) = INTEGRITY.
- **Primary flag severity order: F5 > F1 > F3 > F4 > F2.** F2 deliberately
  overlaps F1; the overlap is what escalates a merchant with Visa disputes and
  no RDR at all.
- **`thin`** marks rows under `MODEL.thinSales` (250) month-to-date sales. It
  marks only — it never changes flags, weight, tier or ranking, and never hides
  a row. 250 is where the model's own numbers meet: 5 chargebacks (the fewest
  that can trip F5) on 250 sales sits exactly on the 2% ceiling.
- `MODEL` edits in Settings are **session-only** and reset on reload. That is
  deliberate: it means a model change you ship actually takes effect for
  everyone instead of being shadowed by someone's saved override.
- `MODEL_VERSION` in `index.html` tracks the scoring model. Bump it only when
  flags, weights, bonus or tiers change — not for display or layout work.

## The monthly reset — where bugs hide

Because counters zero on the 1st:

- **No delta may be computed across a month boundary.** `historyAt()` segments
  each row's points by period and computes `first`/`last` inside the current
  month only. `rec.allFirst` holds the overall first if you need it. A naive
  first→last delta reads the reset as a large improvement — this was a real bug
  with a real example: one MID showed **−1 CB (looks fixed)** when the truth
  inside August was **+1 CB (getting worse)**.
- **Nothing on the audit screen says "month-to-date" any more.** The headline
  went in 2026.09.03 and the tab-line label in 2026.09.04, both at the user's
  request. The footer note (`counters reset to zero on the 1st`) is the only
  remaining on-screen mention; `test_months.js` asserts it is still there via
  `footerPeriod`. The reset still governs every calculation — it is simply no
  longer narrated. Do not re-add prose about it without being asked.
- Sparklines are cut at the boundary (`breaks` map passed to `sparkSVG` /
  `miniSpark.breaks`). The **Per day** toggle (`MT.norm`) divides month-to-date
  totals by day-of-month so the line runs continuously; CB % is already a rate
  and is left alone.
- **Versus last month** (`momHTML`) compares current month-to-date against the
  prior month's *final* report. Lead on rates — the counts are a part-finished
  month against a complete one and are not comparable.
- Anything you add that spans reports must respect this. Check `periodOf()`.

## Layout of `public/index.html`

Documented in the file's own header comment:

1. THEME block (in `<style>`) — all visual tokens, edit values not rules
2. LAYOUT + COMPONENTS — written against those tokens
3. DESIGN SYSTEM — live theme editing
4. MODEL + SCORING — verified, do not edit casually
5. RENDERING — markup generation
6. EXPORT — clipboard / CSV
7. WIRING — event handlers

Key functions: `score()`, `tierOf()`, `analyse()`, `historyAt()`,
`trendsPageHTML()`, `momHTML()`, `exportSet()`, `periodOf()`.

Removed at the user's request, and not to be reinstated without asking:

- 2026.09.03 — the headline summary paragraph, and the whole Scoreboard
  section (heading, both tables, nav chip, `exportSet("score")` path).
- 2026.09.04 — the month-to-date tab label, the Act today / Monitor /
  Quarantine section ledes, the report-ordering note under the trends table,
  the portfolio-trend lede, and the tracker's folder-status paragraph.

**The user wants figures, not narration.** When adding a feature, give it a
heading and the numbers; do not explain it on screen.

## The audit card

Since 2026.09.05 every tier — act today, high, monitor, quarantine, integrity —
renders through one function, `auditCard()`. Twelve figures in fixed positions
so the eye learns the layout once:

    sales · transactions · chargebacks (CB % inline)   volume
    Visa CB · RDR · RDR coverage                       the RDR story
    refunds · refund % · MC CB                         the MC story
    Amex CB · Discover CB                              other brands

Six columns on a wide screen, three below 1000px, two below 640px. Flags are
not shown; the weighted score is, top right. `PRIMARY_LABEL` no longer appears
on screen — it survives only in the export.

**Colour marks which figures are the problem**, never the severity:
`c-rdr` red (F1/F2), `c-mc` blue (F3), `c-gen` orange (F5/F4), and the card's
left rail takes the dominant family. Every tint sits under a label naming the
metric and the action line says the fix in words, so colour is reinforcement
only. Measured value-on-tint contrast, alpha composited: light 4.24 / 3.90 /
5.36, dark 3.44 / 3.65 / 5.40 — all above the 3:1 the THEME block requires.
`--gen-ink` exists because `--serious` is only 2.6:1 as body text on the light
surface; it is the one status colour that is not mode-invariant, and that is
deliberate.

Sorting moved from the old table headers into the controls bar (`#selSort` and
`#btnSortDir`) when the tables became cards, and now applies to every tier
rather than just High and Monitor.

All of that dead weight was swept in 2026.09.06: `FLAGDEF`, `triggerFor()`,
`cardHTML()`, `thHTML()`, `nPer`, `nfTiers` (also dropped from
`tools/audit_dump.js`, which was the only reader), and 23 orphaned CSS rules
— `.headline*`, `.card*`, `td.mono`, `ul.flat*`.

**Two traps that sweep hit, worth knowing before the next one:**

- `flat` is still very much alive as a modifier on `.dlt` / `.dcell` meaning
  "no change". Only the `ul.flat` list rules were dead. A class name being
  unused in one context says nothing about another.
- `.card,.tile,table,.callout,.chart{break-inside:avoid}` in the `@media print`
  block was removed because the selector *began* with the dead `.card`. That
  silently broke page-breaks for tiles, tables, callouts and charts in
  Print / PDF. Shared selector lists must be edited, not deleted.

The method that worked: prove each symbol has no reference outside its own
definition, then diff computed styles for ~20 selectors between the swept and
pre-sweep builds rendered side by side in iframes on the same data. That diff
came back empty, which is what "no visual change" should mean. Harvesting class
names from the rendered DOM alone over-reports badly — conditional state
classes like `v-ok` and `wait` look unused until the state occurs.

Test hooks are exposed on `window.__*` (`__loadForTest`, `__lib`, `__trend`,
`__exportSet`, `__setView`, `__VERSION`, …). Add one rather than reaching into
internals from a test. The tracker adds `__tracker`, `__track`, `__trackStatus`,
`__trackAction`, `__untrack`, `__outcome`, `__outcomes`, `__trackerEvents` and
`__trackInject` — the last replaces the merged log outright, which is how
`test_tracker.js` drives two-device merges and every verdict branch without
touching a folder.

## Editing this file safely

`index.html` is ~186KB in one file. Do not rewrite it wholesale.

- Patch with **anchored single-occurrence replacements** and assert the anchor
  appears exactly once before replacing. A patch script that deletes a range
  once removed several unrelated functions and the page threw on load.
- Watch for **duplicated blocks** — `exportSet` contains two identical
  `if(which==="midtrend")` blocks (the first wins; the second is dead code). An
  anchor there legitimately matches twice.
- **"JS parses OK" proves nothing.** `node --check` passed the entire time the
  page was broken. Load it in a browser and assert on behaviour.

## Verification — run before every release

```bash
./tools/serve.sh &                          # prints the port it chose
BASE_URL=http://127.0.0.1:8111 ./tools/verify.sh
```

Eight steps: version strings agree, app-state dump, field capture (11,284
comparisons), arithmetic against exact `Decimal` plus the portal's own %
columns, grading re-derived from spec, boot + update banner, monthly-reset
behaviour, tracker + outcomes. **Zero mismatches is the only pass** — a step
can exit 0 and still print mismatch counts, so read the numbers.

Requires `fixtures/sample.csv` (a real portal export) and the `fx_*` files from
`tools/make_fixtures.py`. **Fixtures are gitignored on purpose — they contain
real merchant names, MIDs and volumes and must not enter git.**

Known-good baseline for the 14 Aug 2026 export: 806 rows, 1,664 chargebacks,
52 flagged, 14 act today, 14 high, 23 monitor, 39 integrity, worst is Summit
Apex at weighted 21 / 5.09% CB. Brand counts sum exactly to the CB total
(367 + 919 + 193 + 185 = 1,664).

**Verify the served bytes, not the file on disk.** A stale server left running
on the same port once answered every request with an older build and the entire
suite passed against the wrong artifact. `verify.sh` prints both versions at
the top for exactly this reason.

## Releasing

```bash
./release.sh 2026.09.02 "What changed, in one line."
git add -A && git commit -m "release 2026.09.02" && git push
```

`release.sh` stamps `APP_VERSION` in `index.html` and rewrites `version.json`
to match. **They must always agree** — if they diverge, every user gets an
update banner that never clears. `check.sh` enforces it.

Cloudflare deploys on push. Users see the banner within 15 minutes or when they
next focus the tab. Rollback: Cloudflare → Deployments → Rollback.

## Two storage backends

Added 2026.09.12. `FOLDER` owns the state machine, the role logic and the UI
contract; a backend only moves bytes. The contract is nine methods:

    connect  restore  grant  disconnect
    listCsv  readTracker  writeTracker  writeAudit  auditExists  probe

- **`FS_IO`** — File System Access API. Needs a real folder on disk, so in
  practice a sync client, and Chromium. The original, and still the default.
- **`DRIVE_IO`** — Google Drive REST. No sync client, no local folder, and it
  works in Safari and Firefox, which could not share a tracker at all before.

`FOLDER.scan()` does the parsing for both, so the two backends can never
disagree about what a report is. `LS_BACKEND` remembers which one to restore.

**Drive specifics that are easy to get wrong and are covered by tests:**

- Every call must carry `supportsAllDrives=true`, and every list also
  `includeItemsFromAllDrives=true` and `corpora=allDrives`. Without them a
  shared-drive folder is simply invisible — the integration "works" against My
  Drive and silently returns nothing. `test_drive.js` fakes a Drive that
  enforces this and fails 12 assertions by name if it is dropped.
- **Narrowing `fields` on `files.list` drops `nextPageToken`** unless it is
  named explicitly, which silently truncates every result to one page.
  `list()` prepends it. The fake serves 2 per page so this is exercised.
- **`probe()` asks Drive rather than writing.** `capabilities.canAddChildren`
  on the folder is exactly what the FS write-probe was approximating, so the
  Drive route is authoritative, one request, and leaves no probe file behind.
- **Scopes are `drive.readonly` + `drive.file`, not full `drive`.** `drive.file`
  restricts writes to files this app created, which turns "one file per
  browser, never touch anyone else's" from a convention into something Google
  enforces. Both are restricted scopes; an **Internal** Workspace app skips
  verification, which is the only reason this is practical.
- `DRIVE_CLIENT_ID_BAKED` is empty in the repo, and an empty client ID hides
  the Drive option entirely. A client ID is public, not a secret. Settings
  carries an override so it can be tested without a redeploy.
- `__driveInstall` hands DRIVE_IO a live token, which short-circuits `auth()`
  so a test can stub `fetch` and drive the real code. Without a token every
  call still goes through Google.

**Unverified against the real API:** whether `drive.file` permits
`files.create` with a `parents` reference to a folder the app did not create.
It should, and the fake models it that way, but nobody has run it against
Google. If a contributor's first tracker write returns 403, that is the reason
and the fix is adding `drive` to the scope string.

## The tracker

Which deals the team is acting on, and whether the action worked. Added
2026.08.30. It reads scoring output but **never writes to `MODEL`** — no part
of it can move a flag, weight or tier.

- **A tracked thing is a MID held as a string.** Sixteen digits, leading zeros
  intact. Excel turns a bare MID into a float and drops the leading zero, which
  silently breaks every join to next month's export — so all three export paths
  now write it as `="0700100000199484"`, the one wrapper Excel and Sheets both
  read as text. That is what `text:true` on an export column means.
- **State is an append-only event log, never a document.** Each browser writes
  only `tracker/events-<deviceId>.jsonl` inside the connected folder, so two
  people can never write the same file: no locking, no overwritten edit, no
  sync conflict copy. Every browser reads all the files and folds them — last
  event per MID wins, ordered by timestamp then id so the fold is deterministic
  and independent of the order files are read in.
- `FOLDER.scan()` skips subdirectories, so nothing in `tracker/` can be read
  back as a portal export. Same defence as `audits/`.
- **`fold()` must union `mine` and `all`, never choose between them.** Reading
  `this.all` *instead of* `this.mine` once a sync had populated it meant every
  local change was recorded but invisible until a reload — the + button did not
  tick and the status buttons and action dropdown looked dead. Shipped in
  2026.08.30, fixed in 2026.09.01, and `test_tracker.js` now fails by name on
  all three symptoms if it comes back.
- Nothing is written to the folder until there is a real event, so connecting a
  folder does not litter an empty `events-*.jsonl` in a shared drive.
- **One file per browser, rewritten in full on every change, growing forever.**
  The name is stable (`cbrc.tracker.device`), so it is the same file being
  updated, never a new one. About **160 bytes per event**; 20 deals a week
  through all three states is roughly **500 KB a year**. No rotation, no
  compaction — add one only when it is a real problem.
- **`flush()` writes `this.mine`, so `sync()` must reclaim this device's own
  events out of its own file first.** If `localStorage` loses the event list
  while the device id survives, the next change would otherwise rewrite the
  file from a short local list and destroy the rest — and in a shared drive
  that is that person's whole contribution, not just their local history.
  Adoption also restores `seq` from the highest id seen, so a reclaimed log
  never reissues an id. Shipped broken in 2026.08.30, fixed in 2026.09.02;
  `test_tracker.js` fails by name on the truncation if it returns.
- **Statuses:** `required` → `doing` → `done` → `closed`. The baseline is
  snapshotted at **done** and stored on the event itself, so a verdict cannot
  drift when old reports leave the library.

### Folder roles — restricted is not cosmetic

Added 2026.09.09, three roles from 2026.09.10. `FOLDER` carries a role because
the app is client-side JavaScript and **enforces nothing**. The shared drive is
the gate; this is only the mirror.

| role | detected from | may do |
|---|---|---|
| owner | root writable | everything |
| contributor | root read-only, `tracker/` writable | everything except `untrack` |
| viewer | neither writable | nothing |

The contributor line is deliberately **the same line Google draws**: its
Contributor role is "add, edit and share files" — not delete. So the app's
contributor adds a merchant, retargets the action and moves the status, and
cannot remove a tracked deal. Removing takes work off the shared board and its
outcome history with it; that is the owner's.

- **Two probes, not one.** `_probeDir()` runs against the root and against
  `tracker/` separately, because those folders can carry different
  permissions — that is exactly what a shared-drive Viewer holding Contributor
  on `tracker/` looks like, and no single boolean can express it. Google allows
  a folder share to *widen* a member's access inside a shared drive, never
  narrow it, which is why this shape is the one that works.
- `probe()` is the only honest test. Drive, Dropbox and OneDrive all hand out a
  directory handle for a folder they will then refuse to modify, so a granted
  `requestPermission` proves nothing. It runs on `pick()`, `restore()` and
  `grant()` — every connect point.
- The probe file is a dot-file, invisible to both `scan()` (`.csv`) and
  `readTracker()` (`.jsonl`). **It will strand sometimes** — a Contributor may
  create a file and not be permitted to delete it. That is fine and must stay
  fine; never make the probe write anything that could be read as data.
- `detectedRole()` is optimistic when unprobed (`access.root === null`), and
  returns `owner` with **no folder connected** — nothing is shared, so there is
  nobody to mislead.
- `role()` may only ever **narrow** from what was detected. Claiming a role the
  folder will not honour puts the buttons back and breaks the writes behind
  them.
- `TRACKER.mayDo(op)` is the single chokepoint. Every writer — track, untrack,
  action, note, status — goes through `push()`. **Recording locally would be
  worse than refusing**: it would show on that board and no other.
- `action` is open to contributors (2026.09.11). The earlier worry — that
  retargeting mid-measurement rewrites a verdict — does not hold: the baseline
  captured at Done stores **every** metric (`cov cbp mcs s cb vi mc rn`), not
  just the one in force, so switching the action re-reads the same snapshot on
  a different axis rather than inventing a number.
- `trackBtn()` has to split by role because it is a **toggle**. For a
  contributor a tracked row renders a static tick, not a button: offering a
  control whose click would be refused reads as broken.
- `fold()` excludes `this.mine` for a **viewer** only — a contributor genuinely
  writes, so their log belongs in the fold. This is why a role change must
  `sync()` and not merely `fold()`: dropping the local log leaves the board
  blank until the folder refills it.
- `writeFile()` (root) and `writeTracker()` (`tracker/`) refuse independently
  and at different thresholds. The UI hiding a button is not the guard.

The trap: every one of these failures is **silent**. Nothing throws, nothing
looks broken, and the person believes the team can see their work. Step 9 of
`tools/test_tracker.js` is the only thing standing between that and a release —
verify it fails when a guard is removed, not just that it passes.

### Judging whether it worked

Each action type is judged by the metric that would actually move if the fix
landed — a generic CB % delta calls an RDR fix a failure for weeks while it is
quietly working.

| Action | Metric | Good direction |
|---|---|---|
| RDR Fix (ARN Lookup) | RDR coverage % | up |
| MC Fix (Descriptor Lookup) | MC share % | down |
| Agent Flag (fraud team review) | CB % | down |
| Watch | CB % | down |

**Every metric is a rate, and that is not negotiable.** Counts cannot be
compared across the 1st — a count-based verdict would read the monthly reset as
a success every single month. Two gates run before any verdict is shown:

- **Lag.** `TRACKER.lagDays`, default 14, persisted per browser in
  `cbrc.tracker.lag`. **This is a setting, not a measured figure** — there is no
  verified dispute lag for this portfolio. Inside the window an item reads
  *too early*.
- **Denominator.** Below `MODEL.thinSales` the item reads *not enough sales
  yet*, never a percentage. Same floor as the `thin` marker.

Elapsed time is measured from the fix to the **active report's stamp**, not to
the wall clock — the evidence is the report. A fix newer than the newest report
reads *no report since the fix*, which is a different problem from waiting out
the lag and says so.

Verdicts: `improved`, `worse`, `flat`, plus the withheld states `too-early`,
`thin`, `no-report-since`, `missing`, `no-baseline`, `not-available`. The tool
reports movement and never says "fixed" — closing an item stays a human
decision. `flat` is decided by comparing at the displayed precision, so there
is no invented noise threshold.

The tracker export is **27 columns**: the workbook's own first 20, unchanged,
then Status, Done on, Measured by, Baseline, Now, Verdict, Days since. It is a
separate export — the 21-column audit export is untouched by all of it.

## The Trends page

Rewritten 2026.09.07 to the user's spec.

- **Five headline figures**, defined in `met` inside `portfolioTrendHTML()`:
  total chargebacks, total flagged, total MIDs, total RDR, and transactions per
  chargeback (`Σ# Sales ÷ ΣCB #`, the inverse of the portfolio rate).
- Each carries `good:` — `false` rising is worse, `true` rising is better,
  **`null` the direction carries no judgement**. `deltaTag()` renders `null` as
  a neutral grey. Total MIDs uses it: a MID count moving is not good or bad and
  colouring it would assert something untrue.
- **There is no report list.** A ten-column table was tried, then a compact
  month-grouped list; both were the same mistake — restating in text what the
  sparklines above already draw. The lines *are* the list: `sparkSVG` takes
  `pick:true` and renders one invisible hit slice per report, and
  `reportPickerHTML()` reads out whichever point is picked, with ◀ ▶ to step.
  Picking in any tile moves all five and the readout together, via
  `VIEW.repSel`. **The footprint is fixed** — four reports or four hundred cost
  the same height, which is the whole point. `addSnapshot()` resets `repSel`,
  because adding a report changes what an index means.
- `table.mt` marks the first cell of each metric group with `.grpstart`, which
  draws the rule separating one sparkline-plus-delta group from the last.

## Per-user data model

Nothing is shared between users and nothing reaches a server, with one
deliberate exception: tracker events, which are shared through the connected
folder and only with whoever points at the same folder.

- Saved report tabs → that browser's `localStorage` (`cbrc.library.v1`)
- Connected audit folder → File System Access handle in IndexedDB
  (`cbrc.fs`), re-granted each browser session; audits write to an `audits/`
  subfolder
- Tracker events → `localStorage` (`cbrc.tracker.v1`) **and** the connected
  folder's `tracker/` subfolder. Device id in `cbrc.tracker.device`, lag setting
  in `cbrc.tracker.lag`
- Theme, model tweaks, view state → that browser only

The parser **rejects its own audit output** by signature (`tier`, `flags`,
`primary`, `action` headers) so a saved audit cannot be re-ingested as a portal
report. That bug once produced 1,260 chargebacks instead of 1,664. Keep both
defences.

## Open questions and known gaps

- **`$ RDR` is mapped but never captured** — `COLMAP` resolves the header to
  `rd`, but `loadSnapshot` never reads it into the row, so it is not in the row
  object at all. $207,358.82 across 153 MIDs on the Aug 14 export, which exceeds
  the total CB volume of $140,719.52. A dollar-deflection view was designed and
  then dropped; ask before building it.
- **Tracker clock skew.** Fold order is each machine's own timestamp, so a badly
  set clock reorders history. Every change shows its timestamp so it is
  spottable. Not solved.
- **Tracker sharing on the filesystem backend is Chromium-only** — the folder
  API does not exist in Safari or Firefox. The Drive backend covers those, but
  only once a client ID is configured; with none, those browsers still get a
  tracker private to that browser.
- **Bonus band asymmetry**: exactly 5.00% CB gets +3, not +6, because the high
  band is `> 5` while the mid band is `≥ 3`. That is the HIGH / ACT TODAY
  boundary, so it matters. Left as-is deliberately; ask before changing.
- **Exactly 2.00% CB does not trip F5** (the rule is `> 2`). Intentional, but
  worth knowing.
- **Negative refunds**: 7–8 rows carry negative `$ Rfnds` or `CB Vol.`,
  producing negative refund rates. Handled without crashing; nobody has decided
  what they *should* mean.
- **`Avg Sales`** is verified redundant (`$ Sales ÷ # Sales`) and ignored.
- Hosting under `portal.paymenthelp.ai` would make the tool same-origin with
  the report grid and let it fetch `details.jsp` directly, dropping the CSV
  download entirely. No third-party host can do this — browsers block
  cross-origin authenticated requests. Worth chasing if access is possible.

## Tone the user expects

Direct, concrete, no padding. Report what was actually verified and how, name
what you did not check, and flag your own mistakes rather than letting them
surface later. Do not claim something works because it parsed or because it
looked right — say what you ran and what it returned.
