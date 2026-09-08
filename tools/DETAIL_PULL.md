# Chargeback detail — pulling it into the console

The console shows one row per MID (counts). The **detail** behind each MID — the
individual chargebacks, with reason code, dollar amount, card brand, issuing
bank and the **ARN** — lives on the portal, one MID at a time, at
`portal.paymenthelp.ai/search/?mid=<MID>`. There is no bulk export, so this
bookmarklet loops the flagged MIDs on the portal (same-origin, riding your
login) and hands the console one combined CSV.

## One-time: install the bookmarklet

1. Open `tools/bookmarklet-details.url.txt` and copy the whole line (it starts
   with `javascript:`).
2. In Chrome, show the bookmarks bar (⌘⇧B), right-click it → **Add page**.
3. Name it **CB detail pull**, paste the copied line into the **URL** field, save.

(Chromium only, because the pull runs on the portal in your session.)

## Each pull

1. **Console →** load your report, then click **Copy flagged MIDs** (top-right,
   next to Download CSV). That copies the ~52 flagged MIDs.
2. **Portal →** open `portal.paymenthelp.ai/report/`, click the **CB detail
   pull** bookmark. Paste the MIDs when asked (or leave the box blank to pull
   every MID in the grid). A small panel shows progress.
3. When it finishes: **Copy CSV** (then in the console, **Paste report**), or
   **Download details.csv** (then drop it in your console folder, or load it
   with the file picker).

The console recognises a detail file by its columns and joins it to the audit
cards by MID. A **Chargeback detail** panel appears under each flagged card:
reason mix, dollar exposure, top issuers, status, and the ARN list (Visa first,
for RDR work).

## Notes

- **The case list is not the month-to-date CB #.** It spans months and is
  scoped by the portal, so the panel shows it as its own figures and never folds
  it into the count. It is never scored.
- Nothing is uploaded. The bookmarklet reads pages you can already open and
  writes only to your clipboard / downloads; the console holds the detail in
  this browser only.
- If the portal changes its detail-table markup, the parser looks for the table
  whose header has **ARN + Case #**; that selector in
  `tools/bookmarklet-details.js` is what to adjust.
- Later, the weekly Sunday agent does this same pull automatically (same
  endpoint, same output). The bookmarklet is the works-today version.
