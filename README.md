# Chargeback Risk Console — site repo

The deployed website is everything in `public/`. A Cloudflare Worker serves it
as static assets and watches this repo: **a commit to `main` is a deployment.**
Nothing else to run. Live at `cb.yehuda-ceb.workers.dev`.

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

- **Cloudflare:** your Worker → **Deployments** → find the last good version →
  roll back to it. Instant, no repo changes.
- **Git:** `git revert <bad commit> && git push`. Slower but the repo stays
  honest about what happened.

---

## How it is hosted

This is a **Workers static-assets** project, not Pages. Instructions written
for Pages will not match what you see in the dashboard.

| | |
|---|---|
| Serves | everything in `public/`, as static assets |
| Production branch | `main` — a push deploys |
| Build command | none; there is no build step |
| `public/_headers` | honoured (verified live: `/version.json` comes back `no-store`) |

**There is no `wrangler.toml` in this repo.** The build and asset configuration
lives in the Cloudflare dashboard, which means it is *not* reproducible from
git — if the project is ever deleted, those settings have to be re-entered by
hand. Read them off the dashboard before you touch anything there.

One Workers-specific behaviour that has already tripped a check: requesting
`/index.html` returns a **307** to `/`. Ask for `/`, not `/index.html`, when
you curl the live site — `tools/verify.sh` fetches `$BASE_URL/index.html`,
which is correct against the local `serve.sh` but comes back empty against the
Worker.

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

## The tracker

**Tracker** tab. Press **+** beside any merchant on the Audit tab to put it on
the board, tag what needs doing, and move it through **Action required → In
progress → Action done**. Rows group by action, so four MIDs needing the same
operation read as one job.

The moment a row hits *Action done*, the console snapshots that MID's numbers.
The **Outcomes** view then compares them against every later report and tells
you what moved.

Each action is judged by the figure that would actually change if it worked —
an RDR fix by RDR coverage, a descriptor fix by Mastercard's share of disputes,
a fraud review or a watch by CB %. All of them are rates, never counts, because
the portal zeroes every counter on the 1st and a count would report the reset
as a success every month.

A verdict is withheld until it means something. Inside the lag window it reads
*too early*; below the thin-sales floor, *not enough sales yet*; if your newest
export predates the fix, *no report since the fix*. The tool reports movement —
`RDR coverage 0.0% → 61.5%` — and never claims something is fixed. Closing an
item is your call.

The measurement lag is in Settings, default 14 days. **It is a setting, not a
measured figure** — set it from your own experience of how long disputes take
to post.

### Sharing it with your team

Connect the same folder — Dropbox, Drive, OneDrive, a network share — on each
person's machine. Each browser appends only to its own file in a `tracker/`
subfolder, so nobody can overwrite anybody; every browser reads all of them and
merges. Press **Sync with team** to pull in what others have done.

Two ways to reach the folder:

- **A folder on this computer** — needs Chrome or Edge and a sync client
  (Drive for Desktop). The original route, and the one Yehuda uses.
- **Connect Google Drive** — reaches the same folder over the web. No sync
  client, no local folder, and it works in Safari and Firefox too. Requires a
  Google OAuth client ID to be configured; without one the option is hidden.

Without either, the tracker still works, private to that browser.

### Turning on the Google Drive route

One-time setup in Google Cloud, by a Workspace admin:

1. **console.cloud.google.com** → new project (or an existing one).
2. **APIs & Services → Library** → enable **Google Drive API**.
3. **OAuth consent screen** → User type **Internal**. This is the important
   one: Internal skips Google's verification review, which the scopes below
   would otherwise require.
4. **Credentials → Create credentials → OAuth client ID** → **Web application**.
   Authorised JavaScript origin: `https://cb.yehuda-ceb.workers.dev`
   (add `http://127.0.0.1:8111` too if you want it working locally).
5. Copy the client ID into **Settings → This browser's folder access**, or bake
   it into `DRIVE_CLIENT_ID_BAKED` in `index.html` so nobody has to.

Scopes requested are `drive.readonly` and `drive.file` — read what is shared
with you, write only files this app itself created. A client ID is public and
is safe in the source; it identifies the app and authorises nothing on its own.

**One caveat worth knowing before you roll it out.** Whether `drive.file`
allows creating a file inside a folder the app did not create is the single
thing that cannot be tested without a live client ID. It should work and the
test suite models it that way. If the first tracker write from a teammate
returns a permissions error, that is why — adding
`https://www.googleapis.com/auth/drive` to the scope string in `DRIVE_IO.SCOPES`
fixes it at the cost of a broader grant.

### One editor, everyone else moves the status

The audit folder lives in **Google Shared Drives → CB Audit → CB Audit
Location**. Who may write is decided there, not in the app.

**This is configured and live** (set up 2026-08-30):

| | CB Audit drive | `tracker/` | Add exports | Save audits | Move a status |
|---|---|---|---|---|---|
| yehuda@ | Manager | Manager | yes | yes | yes |
| andrew@ | Viewer | **Contributor** | no | no | **yes** |
| ben@ | Viewer | **Contributor** | no | no | **yes** |
| brett@ | Viewer | **Contributor** | no | no | **yes** |
| luis@ | Viewer | **Contributor** | no | no | **yes** |

The folder-level Contributor grant is legal because inside a shared drive a
folder can be shared to grant *more* access than someone's drive-level role —
never less. That is the whole reason this lives in its own shared drive rather
than in **PaymentHelp**: the four of them hold Manager or Content manager
there, and Google gives no way to narrow that for one folder. Moving the audit
out was the only way to restrict it without touching their access to CB Ratios,
Residual Reports, VPN Connect and the rest of PaymentHelp.

### What the app does with that

At every connect it writes a throwaway dot-file to the folder **and to
`tracker/`**, then deletes them. Two probes, because those two folders can
carry different permissions — no single writable/not-writable flag can tell
contributor apart from owner. What it finds picks the role:

**Contributor** — badge reads **Status only**. The four status buttons work and
sync to the team. The action dropdown becomes a plain label, Remove disappears,
the `+` on audit rows disappears, **Save audit** disappears.

**Viewer** — badge reads **View only**. Everything above is text. **Refresh
from team** still pulls the whole board.

This matters more than it sounds. Without any of it a restricted person's
clicks land in their own browser storage, fold into their own board, and look
exactly like a change the team can see — while reaching nobody. Restricted has
to *look* restricted.

**Settings → This browser's folder access** shows what was detected — including
each folder's answer — offers a **Re-check** after you change someone's role,
and has a menu to hold a browser to a lower role than the folder allows. It
can only narrow, never widen: claiming a role the drive won't honour would put
the buttons back and break the writes behind them.

Two honest limits. A Contributor can *edit* existing files, so this protects
against deletion and accident, not against a determined edit — fine for a
trusted team, worth knowing. And one 0-byte `.cbrc-access-check` may sit in
`tracker/` on a contributor's machine, because they are allowed to create it
and not to delete it; it is invisible to the app, which reads only `.csv` and
`.jsonl`.

---

## What is not shared between users

Each person's data is theirs alone and lives on their own computer:

- **Saved report tabs** — that browser's local storage, that device only.
- **Connected audit folder** — a handle to their own disk, re-granted each
  browser session. On the Google Drive route, an access token held in memory
  only and never written down.
- **Tracker state** — shared, but only through the folder, and only with people
  pointing at the same one.
- **Theme and scoring-model tweaks** — that browser only. Model tweaks are
  session-only and reset on reload, so an updated scoring model always takes
  effect.

Two people on the same URL get the same tool and completely separate data.
Nothing crosses between them, and no report data reaches any server of ours.

How much the page talks to the network depends on which route you connect by,
and it is worth being exact about:

- **A folder on this computer** — exactly one call in the page's life: a fetch
  of its own `version.json`, which carries no data. Reports are read off the
  disk and never uploaded.
- **Google Drive** — that same call, plus Google's own sign-in and the Drive
  API. Reports and tracker files travel between the browser and Google, which
  is where they already live. Nothing is sent anywhere else, and there is still
  no server of ours in the path — but "nothing ever leaves the browser" is only
  literally true of the first route, and it would be sloppy to keep saying it
  of both.

---

## Restricting who can open it

The page ships no merchant data — it is an empty tool until someone loads their
own CSV, and that CSV is read in the browser and never uploaded. An open URL
leaks nothing but the scoring logic itself.

If you want per-person logins: **Zero Trust** → **Access** → **Applications**
→ **Add an application** → **Self-hosted**. Set the domain to the bare
hostname and add a policy of **Allow / Include → Emails**.

Watch the wildcard: if the dashboard prefills a `*.` form of the hostname, that
covers *preview* URLs only. Delete the `*.` and set the bare production
hostname, or production stays open while the sign-in screen appears to work.
Test in a private window before sending anyone the link.

---

## Later, if it's ever possible

Hosting this under `portal.paymenthelp.ai` is the one upgrade that changes what
the tool can do rather than where it lives. Same-origin with the report grid is
the only way it could fetch `details.jsp` directly and drop the CSV download
step entirely. No third-party host can do this at any price — browsers block
cross-origin authenticated requests and no code change gets around it.

---

## Working on this

`CLAUDE.md` is the project brief — architecture, the scoring model, the
monthly-reset rules, the invariants that must not drift, and the traps that
have already cost time. Read it before changing `public/index.html`.

`tools/` holds the verification harness. Run it before every release:

```bash
./tools/serve.sh &
BASE_URL=http://127.0.0.1:8111 ./tools/verify.sh
```

It needs a real portal export at `fixtures/sample.csv`. **Fixtures are
gitignored deliberately — they contain real merchant names, MIDs and volumes
and must not enter git.**
