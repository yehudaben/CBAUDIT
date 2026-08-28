# Chargeback Risk Console — site repo

The deployed website is everything in `public/`. Cloudflare Pages watches this
repo: **a commit to `main` is a deployment.** Nothing else to run.

```
public/index.html     the console itself — one self-contained file, this IS the app
public/version.json   the build number the page checks to notice updates
public/_headers       cache rules, so nobody gets served a stale build

release.sh            bumps the build number in both files at once
check.sh              verifies the two version strings match
README.md             this file — never deployed, it lives outside public/
```

Only `public/` reaches the internet. Scripts and docs at the repo root are not
served.

---

## Shipping an update

```bash
# 1. edit the console
vim public/index.html

# 2. bump the build (writes index.html AND version.json, then verifies)
./release.sh 2026.09.02 "Adds the $ RDR deflection column."

# 3. ship
git add -A
git commit -m "release 2026.09.02"
git push
```

Cloudflare picks up the push and deploys in under a minute. Anyone with the
tab open gets the update banner within 15 minutes, or the instant they switch
back to that tab. Reloading never touches their saved reports or their
connected folder.

The `notes` argument is what users read in the banner. Leave it off for a
silent fix.

### The one failure mode

`APP_VERSION` in `index.html` and `version.json` must carry the same string.
If they disagree, every user gets a banner that nags forever and a reload that
never clears it. `release.sh` writes both, and `check.sh` refuses a mismatch —
which is the entire reason those two scripts exist. Run `./check.sh` if you
ever edit the version by hand.

### Rolling back

Two ways, either is fine:

- **Cloudflare:** your project → **Deployments** → find the last good one →
  **Rollback to this deployment**. Instant, no repo changes.
- **Git:** `git revert <bad commit> && git push`. Slower but the repo stays
  honest about what happened.

---

## First-time setup

Already done if the site is live. Recorded here so it can be rebuilt.

**Cloudflare build settings** (project → Settings → Build):

| Setting | Value |
|---|---|
| Framework preset | None |
| Build command | *(leave blank)* |
| Build output directory | `public` |
| Production branch | `main` |

**Important:** a Pages project is either Git-connected or Direct Upload, and
they are not interchangeable — Cloudflare's docs are explicit that a
Git-connected project cannot be switched to Direct Upload later, and there is
no supported path the other way either. If a drag-and-drop project already
exists, create a **new** project via *Connect to Git* and delete the old one.

---

## The monthly reset

The portal zeroes every counter on the 1st, so every figure in a report is
**month-to-date** — not daily, not lifetime. The console is built around that:

- The headline names the month and how far into it you are.
- Trend deltas are computed **inside a month only**. Comparing across the 1st
  would read the reset itself as a large improvement.
- Sparklines are cut at each month boundary. A **Per day** toggle divides each
  month-to-date total by the day of the month if you want a line that runs
  straight through; CB % is already a rate and is unchanged by it.
- **Versus last month** compares current month-to-date against the prior
  month's *final* report. Read the CB % columns there, not the counts — a
  part-finished month naturally has fewer of everything.
- Rows under `MODEL.thinSales` month-to-date sales (default 250) carry a
  **thin** marker. They still score and still rank; the marker only says the
  rate sits on a small denominator. 250 is where the model's own numbers meet:
  5 chargebacks — the fewest that can trip F5 — on 250 sales is exactly the 2%
  ceiling. The floor is adjustable in Settings.

The 21-column audit export is unchanged.

---

## What is not shared between users

Each person's data is theirs alone and lives on their own computer:

- **Saved report tabs** — that browser's local storage, that device only.
- **Connected audit folder** — a handle to their own disk, re-granted each
  browser session.
- **Theme and scoring-model tweaks** — that browser only. Model tweaks are
  session-only and reset on reload, so an updated scoring model always takes
  effect.

Two people on the same URL get the same tool and completely separate data.
Nothing crosses between them, and no report data ever reaches a server. The
page makes exactly one network call, ever: a fetch of its own `version.json`,
which carries no data.

---

## Restricting who can open it

The page ships no merchant data — it is an empty tool until someone loads their
own CSV, and that CSV is read in the browser and never uploaded. An open URL
leaks nothing but the scoring logic itself.

If you want per-person logins: **Zero Trust** → **Access** → **Applications**
→ **Add an application** → **Self-hosted**. Set the domain to the bare
hostname and add a policy of **Allow / Include → Emails**.

Watch the wildcard: Cloudflare may prefill `*.<project>.pages.dev`, which
covers *preview* deployments only. Delete the `*.` or production stays open
while the sign-in screen appears to work. Test in a private window before
sending anyone the link.

---

## Later, if it's ever possible

Hosting this under `portal.paymenthelp.ai` is the one upgrade that changes what
the tool can do rather than where it lives. Same-origin with the report grid is
the only way it could fetch `details.jsp` directly and drop the CSV download
step entirely. No third-party host can do this at any price — browsers block
cross-origin authenticated requests and no code change gets around it.
