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
  uploaded. The only network call the page ever makes is fetching its own
  `version.json` to detect a new deployment.
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
- **Statuses:** `required` → `doing` → `done` → `closed`. The baseline is
  snapshotted at **done** and stored on the event itself, so a verdict cannot
  drift when old reports leave the library.

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
- **Tracker sharing is Chromium-only** — the folder API does not exist in Safari
  or Firefox, so those browsers get a tracker that is private to that browser.
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
