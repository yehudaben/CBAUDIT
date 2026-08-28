# tools/ — verification harness

Nothing here is deployed. `public/` is the website; this directory is how you
find out whether a change broke it.

## One-time setup

```bash
npm install            # playwright
npx playwright install chromium
```

Then put a real portal export at `fixtures/sample.csv` and build the
multi-month fixtures from it:

```bash
python3 tools/make_fixtures.py fixtures/sample.csv
```

**`fixtures/` is gitignored and must stay that way** — those files contain real
merchant names, MIDs and volumes.

## Running

```bash
./tools/serve.sh &                          # prints the port it chose
BASE_URL=http://127.0.0.1:8111 ./tools/verify.sh
```

`verify.sh` prints the version string of the **served** build next to the one
in the file and tells you they must match. Check it. A stale server on the same
port will answer with an old build and every test below will pass against the
wrong artifact — this has actually happened.

## What each step proves

| Step | What it checks |
|---|---|
| `check.sh` | `APP_VERSION` and `version.json` agree |
| `audit_dump.js` | loads the sample in a real browser, dumps app state to `fixtures/app_dump.json` |
| `audit_A_fields.py` | every field the app parsed matches the CSV — 11,284 comparisons |
| `audit_B_math.py` | every metric recomputed with exact `Decimal`, plus cross-check against the portal's own `% CB` and `% Rfnds` columns |
| `audit_C_grading.py` | all 806 rows re-graded from the written spec, independently of the app's code — flags, bonus, weight, primary, tier |
| `test_boot.js` | boots clean, parses the sample, update banner appears only on a version mismatch |
| `test_months.js` | monthly reset: no delta crosses a reset, per-day toggle, Versus last month, thin marker |

**Zero mismatches is the only pass.** A step can exit 0 and still print
mismatch counts — read the numbers, do not trust the exit code alone.

## Environment variables

| Variable | Default | Use |
|---|---|---|
| `BASE_URL` | `http://127.0.0.1:8111` | where the site is served |
| `SAMPLE_CSV` | `fixtures/sample.csv` | the portal export to audit against |
| `FIXTURES` | `fixtures/` | where the `fx_*` files live |
| `CHROMIUM` | unset | path to a preinstalled Chromium; unset lets Playwright use its own |
| `PORT` | `8111` | starting port for `serve.sh`, which skips busy ones |

## Adding a test

Expose what you need on `window.__*` in `index.html` rather than reaching into
internals from the test — there are already hooks for the library, trends,
exports, view switching and the version state. Assert on behaviour in a real
browser; `node --check` passing means nothing.
