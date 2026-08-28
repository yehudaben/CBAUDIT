const {chromium} = require('playwright');
const fs = require('fs');
const path = require('path');
/* Same environment contract as the other tests: BASE_URL to point at a
   served copy, SAMPLE_CSV for the portal export (kept out of git). */
const BASE   = process.env.BASE_URL   || 'http://127.0.0.1:8111';
const ROOT   = path.resolve(__dirname, '..');
const FIX    = process.env.FIXTURES   || path.join(ROOT, 'fixtures');
const SAMPLE = process.env.SAMPLE_CSV || path.join(FIX, 'sample.csv');
const LAUNCH = process.env.CHROMIUM ? {executablePath: process.env.CHROMIUM} : {};

/* Real MIDs from the 14 Aug baseline, chosen for what they exercise:
   894949 has 585 sales (clears the thin floor) and RDR coverage 81.8%;
   967398 has 180 sales, so every verdict on it must be withheld;
   916148 has 146 sales; 199485 is Summit Apex, RDR coverage 0. */
const M_FAT  = '0567000000894949';
const M_THIN = '0567000000967398';
const M_APEX = '0700100000199485';
const OLD    = '2026-07-25T09:00:00Z';   // 19 days before the report — lag elapsed
const NEW    = '2026-08-13T09:00:00Z';   // 1 day before — lag not elapsed
const FUT    = '2026-09-20T09:00:00Z';   // after the newest report

const ev = (id, mid, op, extra) =>
  Object.assign({id, ts: OLD, dev: 'test', mid, op}, extra || {});
const base = o => Object.assign(
  {stamp: '2026-07-24 09:00:00', cov: 0, cbp: 4, mcs: 50, s: 500, cb: 20}, o || {});

(async () => {
  const browser = await chromium.launch(LAUNCH);
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', e => errs.push('PAGEERROR: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') errs.push('CONSOLE: ' + m.text()); });

  const R = {};
  await page.goto(BASE + '/index.html', {waitUntil: 'networkidle'});
  /* start from a clean tracker — localStorage survives between runs */
  await page.evaluate(() => { try { localStorage.removeItem('cbrc.tracker.v1'); } catch (e) {} });
  await page.reload({waitUntil: 'networkidle'});
  R.bootErrors = errs.slice();

  const csv = fs.readFileSync(SAMPLE, 'utf8');
  await page.evaluate(t => window.__loadForTest(t, '2026-08-14-0901.csv'), csv);
  await page.waitForTimeout(900);
  R.afterLoadErrors = errs.slice(R.bootErrors.length);

  /* ---- 1. the control exists on every actionable row, and toggles ---- */
  R.trackControls = await page.evaluate(() => document.querySelectorAll('[data-track]').length);
  R.toggle = await page.evaluate(async () => {
    const b = document.querySelector('[data-track]');
    const mid = b.getAttribute('data-track');
    b.click();
    const on = window.__tracker().rows.length;
    document.querySelector(`[data-track="${mid}"]`).click();
    const off = window.__tracker().rows.length;
    return {on, off, mid};
  });

  /* ---- 2. the action defaults to what the row's own flags argue for ---- */
  R.suggested = await page.evaluate(m => {
    const t = window.__track(m);
    return {action: t.action, status: t.status};
  }, M_APEX);

  /* ---- 3. Done captures a baseline; it must not be invented ---- */
  R.baselineOnDone = await page.evaluate(m => {
    const t = window.__trackStatus(m, 'done');
    return {status: t.status, hasBaseline: !!t.baseline, doneAt: !!t.doneAt,
            cov: t.baseline ? t.baseline.cov : null};
  }, M_APEX);

  /* ---- 4. every verdict branch, driven from an injected log ---- */
  R.verdicts = await page.evaluate(a => {
    const [FAT, THIN, APEX, OLD, NEW, FUT] = a;
    const mk = (id, mid, op, x) => Object.assign({id, ts: OLD, dev: 'test', mid, op}, x || {});
    const bl = o => Object.assign(
      {stamp: '2026-07-24 09:00:00', cov: 0, cbp: 4, mcs: 50, s: 500, cb: 20}, o || {});
    const out = {};

    const run = (label, evs) => {
      window.__trackInject(evs);
      const o = window.__outcomes();
      out[label] = o.map(x => ({mid: x.mid, verdict: x.verdict,
        base: x.base == null ? null : +Number(x.base).toFixed(x.dp),
        now:  x.now  == null ? null : +Number(x.now ).toFixed(x.dp),
        elapsed: x.elapsedDays}));
    };

    /* RDR fix, coverage 0 -> 81.8 on 585 sales */
    run('improved', [mk('a1', FAT, 'track', {action: 'RDR Fix (ARN Lookup)'}),
                     mk('a2', FAT, 'status', {value: 'done', baseline: bl({cov: 0})})]);
    /* MC fix, share 40 -> 64 on 585 sales */
    run('worse',    [mk('b1', FAT, 'track', {action: 'MC Fix (Descriptor Lookup)'}),
                     mk('b2', FAT, 'status', {value: 'done', baseline: bl({mcs: 40})})]);
    /* CB % identical at the displayed precision */
    run('flat',     [mk('c1', FAT, 'track', {action: 'Watch'}),
                     mk('c2', FAT, 'status', {value: 'done', baseline: bl({cbp: 4.2735042})})]);
    /* 180 sales: under the thin floor, so no verdict even though it moved */
    run('thin',     [mk('d1', THIN, 'track', {action: 'MC Fix (Descriptor Lookup)'}),
                     mk('d2', THIN, 'status', {value: 'done', baseline: bl({mcs: 80})})]);
    /* done one day before the report — inside the lag window */
    run('tooEarly', [mk('e1', FAT, 'track', {action: 'RDR Fix (ARN Lookup)', ts: NEW}),
                     mk('e2', FAT, 'status', {value: 'done', ts: NEW, baseline: bl({cov: 10})})]);
    /* done after the newest report exists — nothing to measure yet */
    run('noReport', [mk('f1', FAT, 'track', {action: 'RDR Fix (ARN Lookup)', ts: FUT}),
                     mk('f2', FAT, 'status', {value: 'done', ts: FUT, baseline: bl({cov: 0})})]);
    /* a MID that is not in this report at all */
    run('missing',  [mk('g1', '9999999999999999', 'track', {action: 'Watch'}),
                     mk('g2', '9999999999999999', 'status', {value: 'done', baseline: bl()})]);
    return out;
  }, [M_FAT, M_THIN, M_APEX, OLD, NEW, FUT]);

  /* ---- 4b. local edits stay visible once a folder sync has run ----
     Regression: fold() read this.all *instead of* this.mine, so after a sync
     every local change was recorded but invisible until reload. The + button
     did not tick and the status buttons and action dropdown looked dead. */
  R.liveAfterSync = await page.evaluate(a => {
    const [FAT, THIN, APEX] = a;
    /* start clean, then stand in a teammate's event as a sync would */
    window.__trackInject([]);
    TRACKER.all = [{id: 'team-1', ts: '2026-08-01T10:00:00Z', dev: 'other',
                    mid: FAT, op: 'track', action: 'Watch'}];
    TRACKER.fold(); render();

    /* every lookup is guarded: when this regresses the controls are simply
       absent, and a named assertion is more use than a null-pointer crash */
    const q = sel => document.querySelector(sel);
    const btn = q(`[data-track="${APEX}"]`);
    const beforeTick = btn ? btn.classList.contains('on') : null;
    if (btn) btn.click();
    const after = q(`[data-track="${APEX}"]`);
    const ticked = !!after && after.classList.contains('on') && after.textContent.trim() === '\u2713';

    window.__setView('tracker');
    const row = () => (window.__tracker().rows.filter(r => r.mid === APEX)[0] || {});
    const stBtn = q(`[data-status-for="${APEX}"][data-status="doing"]`);
    if (stBtn) stBtn.click();
    const status = row().status || null;
    const lit = q(`[data-status-for="${APEX}"][data-status="doing"]`);
    const statusLit = !!lit && lit.classList.contains('on');

    const sel = q(`[data-action-for="${APEX}"]`);
    if (sel) { sel.value = 'MC Fix (Descriptor Lookup)'; sel.dispatchEvent(new Event('change')); }
    const action = row().action || null;
    const after2 = q(`[data-action-for="${APEX}"]`);
    const selShows = after2 ? after2.value : null;

    return {beforeTick, ticked, status, statusLit, action, selShows,
            controlsFound: {track: !!btn, status: !!stBtn, action: !!sel},
            teamRowKept: window.__tracker().rows.some(r => r.mid === FAT),
            buckets: [...document.querySelectorAll('.bkt')].map(n => n.textContent.trim())};
  }, [M_FAT, M_THIN, M_APEX]);

  /* ---- 4c. a device reclaims its own history from its own file ----
     Regression: flush() rewrites events-<id>.jsonl from this.mine alone. If
     localStorage loses the event list while the device id survives (storage
     eviction, a partial clear), the next change truncated the file to one
     line — destroying that person's whole contribution to a shared drive. */
  R.reclaim = await page.evaluate(a => {
    const [FAT, THIN, APEX] = a;
    const files = {};
    FOLDER.state = 'connected'; FOLDER.name = 'TestFolder'; FOLDER.handle = {};
    FOLDER.writeTracker = async (n, x) => { files[n] = x; return n; };
    FOLDER.readTracker  = async () => Object.keys(files).map(n => ({name: n, text: files[n]}));

    return (async () => {
      TRACKER.mine = []; TRACKER.all = []; TRACKER.seq = 0;
      TRACKER.track(APEX); TRACKER.setStatus(APEX, 'doing');
      TRACKER.track(FAT);  TRACKER.setStatus(FAT, 'done');
      await TRACKER.flush();
      const name = TRACKER.fileName();
      const before = files[name].trim().split('\n').length;

      /* lose the event list, keep the device id */
      TRACKER.mine = []; TRACKER.seq = 0;
      await TRACKER.sync();
      const adopted = TRACKER.adopted, mineAfter = TRACKER.mine.length;

      TRACKER.track(THIN);
      await TRACKER.flush();
      const lines = files[name].trim().split('\n');
      const ids = lines.map(l => JSON.parse(l).id);
      return {before, adopted, mineAfter, after: lines.length,
              uniqueIds: new Set(ids).size === ids.length,
              rowsVisible: Object.keys(TRACKER.state).length};
    })();
  }, [M_FAT, M_THIN, M_APEX]);

  /* ---- 5. two people, two files, no overwrite ----
     Events from two devices fold into one state, and the later timestamp
     wins the field without erasing the earlier event from the log. */
  R.merge = await page.evaluate(a => {
    const [FAT] = a;
    const evs = [
      {id: 'A-1', ts: '2026-08-01T10:00:00Z', dev: 'A', mid: FAT, op: 'track', action: 'Watch'},
      {id: 'B-1', ts: '2026-08-02T10:00:00Z', dev: 'B', mid: FAT, op: 'action',
       value: 'MC Fix (Descriptor Lookup)'},
      {id: 'A-2', ts: '2026-08-03T10:00:00Z', dev: 'A', mid: FAT, op: 'status', value: 'doing'},
      {id: 'B-2', ts: '2026-08-04T10:00:00Z', dev: 'B', mid: FAT, op: 'status', value: 'done',
       baseline: {stamp: '2026-08-04 10:00:00', cov: 0, cbp: 4, mcs: 40, s: 500, cb: 20}}
    ];
    window.__trackInject(evs);
    const t = window.__tracker().rows[0];
    /* the same events applied in reverse order must fold identically */
    window.__trackInject(evs.slice().reverse());
    const t2 = window.__tracker().rows[0];
    return {action: t.action, status: t.status, hasBaseline: t.hasBaseline,
            orderIndependent: JSON.stringify(t) === JSON.stringify(t2),
            eventsKept: evs.length};
  }, [M_FAT]);

  /* ---- 6. untrack removes the row entirely ---- */
  R.untrack = await page.evaluate(a => {
    const [FAT] = a;
    window.__trackInject([
      {id: 'u1', ts: '2026-08-01T10:00:00Z', dev: 'A', mid: FAT, op: 'track', action: 'Watch'},
      {id: 'u2', ts: '2026-08-02T10:00:00Z', dev: 'A', mid: FAT, op: 'untrack'}
    ]);
    return window.__tracker().rows.length;
  }, [M_FAT]);

  /* ---- 7. the export keeps the workbook's first 20 columns, MID as text ---- */
  R.exportShape = await page.evaluate(a => {
    const [FAT] = a;
    window.__trackInject([
      {id: 'x1', ts: '2026-08-01T10:00:00Z', dev: 'A', mid: FAT, op: 'track',
       action: 'RDR Fix (ARN Lookup)'}
    ]);
    const set = trackerExportSet();
    /* index by header, and read the TSV: merchant names contain commas, so
       splitting the CSV on "," lands in the wrong field */
    const i = set.head.indexOf('MID');
    const cell = toTSV(set).split('\n')[1].split('\t')[i];
    const rawMid = String(set.rows[0][i]).replace(/[="]/g, '');
    return {cols: set.head.length,
            first20: set.head.slice(0, 20).join('|'),
            added: set.head.slice(20),
            midIndex: i,
            midCell: cell,
            midIsText: /^="\d{16}"$/.test(cell),
            csvHasTextWrapper: toCSV(set).indexOf('=""' + rawMid + '""') >= 0};
  }, [M_FAT]);

  /* ---- 8. the audit export is untouched by any of this ---- */
  R.auditExportUnchanged = await page.evaluate(() => {
    const set = window.__exportSet('all');
    return {cols: set.head.length, order: set.head.join('|')};
  });

  /* ---- 9. read-only folder: the viewer role ----
     A teammate with view-only access to the shared drive must get a board
     that cannot be edited, not one whose edits vanish. The failure this
     guards is silent: without it every click is recorded locally, folds into
     that person's own view, and reaches nobody.

     Step 4c left FOLDER.handle as a bare stub, so this installs a handle of
     its own — one that hands out a file handle and then refuses the write,
     which is exactly how a read-only synced drive behaves. */
  R.readOnly = await page.evaluate(async (mids) => {
    const [FAT] = mids;
    const out = {}, files = {}, tfiles = {};
    const H = {
      __ro: false, __files: {},
      async getFileHandle(n, o){
        const self = this;
        if ((!o || !o.create) && !(n in self.__files)) {
          const e = new Error('not found'); e.name = 'NotFoundError'; throw e;
        }
        return {async createWritable(){
          if (self.__ro) { const e = new Error('read-only'); e.name = 'NotAllowedError'; throw e; }
          return {async write(b){ self.__files[n] = b.size || 0; files[n] = 1; },
                  async close(){}};
        }};
      },
      async removeEntry(n){ delete this.__files[n]; }
    };
    FOLDER.handle = H; FOLDER.state = 'connected'; FOLDER.name = 'TestFolder';
    FOLDER.writeTracker = async (n, x) => {
      if (!FOLDER.canWrite()) throw new Error('read-only');
      tfiles[n] = x; return n;
    };
    FOLDER.readTracker = async () => Object.keys(tfiles).map(n => ({name: n, text: tfiles[n]}));

    /* writable to begin with, with one row the team can see */
    await window.__mockReadOnly(false);
    TRACKER.mine = []; TRACKER.all = []; TRACKER.seq = 0; TRACKER.fold();
    window.__track(FAT, 'Watch');
    out.ownerCanTrack = !!window.__tracker().rows.find(r => r.mid === FAT);
    out.ownerRole     = window.__folderRole();

    /* the drive goes read-only under us — exactly the teammate's case */
    const w = await window.__mockReadOnly(true);
    out.probeDetects   = (w === false);
    out.viewerRole     = window.__folderRole();
    out.probeCleanedUp = !window.__folderRole().probeLeft;
    out.teamRowVisible = !!window.__tracker().rows.find(r => r.mid === FAT);

    /* every writer must refuse, and refuse rather than record locally */
    const before = window.__trackerEvents().length;
    window.__trackStatus(FAT, 'doing');
    window.__trackAction(FAT, 'Agent Flag');
    window.__untrack(FAT);
    out.eventsAdded     = window.__trackerEvents().length - before;
    out.statusUnchanged = (window.__tracker().rows.find(r => r.mid === FAT) || {}).status;

    /* the controls that would do nothing are not rendered */
    window.__setView('tracker');
    out.statusButtons  = document.querySelectorAll('[data-status-for]').length;
    out.actionSelects  = document.querySelectorAll('[data-action-for]').length;
    out.removeButtons  = document.querySelectorAll('[data-untrack]').length;
    out.trackButtons   = document.querySelectorAll('[data-track]').length;
    out.readOnlyLabels = document.querySelectorAll('.trkro, .trkst.ro').length;
    out.stripButtons   = window.__strip().buttons;
    out.badge          = !!document.querySelector('.robadge');

    /* refused at the FOLDER layer too, not merely hidden in the UI. Tested
       against writeFile directly: saveCurrentToFolder catches and toasts. */
    try { await FOLDER.writeFile('x.csv', 'a'); out.saveThrew = false; }
    catch (e) { out.saveThrew = /read-only/i.test(e.message); }

    /* back to writable: controls return and writing works again */
    await window.__mockReadOnly(false);
    window.__setView('tracker');
    out.controlsReturn = document.querySelectorAll('[data-status-for]').length > 0;
    const b2 = window.__trackerEvents().length;
    window.__trackStatus(FAT, 'doing');
    out.writesResume = window.__trackerEvents().length - b2;

    /* the explicit override: a browser that CAN write choosing not to */
    await window.__setRolePref('viewer');
    out.forcedViewer = window.__folderRole().viewer;
    const b3 = window.__trackerEvents().length;
    window.__trackStatus(FAT, 'done');
    out.forcedBlocks = window.__trackerEvents().length - b3;
    await window.__setRolePref('auto');
    out.restored = !window.__folderRole().viewer;
    return out;
  }, [M_FAT]);

  R.finalErrors = errs.slice(R.bootErrors.length + R.afterLoadErrors.length);
  console.log(JSON.stringify(R, null, 2));

  /* ---- assertions: zero tolerance, same as every other step ---- */
  const fail = [];
  const want = (cond, msg) => { if (!cond) fail.push(msg); };

  want(R.bootErrors.length === 0, 'boot errors: ' + R.bootErrors.join(' | '));
  want(R.afterLoadErrors.length === 0, 'errors after load: ' + R.afterLoadErrors.join(' | '));
  want(R.finalErrors.length === 0, 'errors during tracker use: ' + R.finalErrors.join(' | '));
  want(R.trackControls === 91, 'expected 91 track controls, got ' + R.trackControls);
  want(R.toggle.on === 1 && R.toggle.off === 0, 'track toggle did not round-trip');
  want(R.suggested.action === 'RDR Fix (ARN Lookup)',
       'F1/F2 row should suggest the RDR fix, got ' + R.suggested.action);
  want(R.suggested.status === 'required', 'a new row must start as required');
  want(R.baselineOnDone.hasBaseline && R.baselineOnDone.doneAt,
       'Done must capture a baseline and a timestamp');

  const v = (k) => (R.verdicts[k] && R.verdicts[k][0]) || {};
  want(v('improved').verdict === 'improved', 'coverage 0 -> 81.8 should read improved');
  want(v('worse').verdict === 'worse', 'MC share 40 -> 64 should read worse');
  want(v('flat').verdict === 'flat', 'an unchanged rate should read no change');
  want(v('thin').verdict === 'thin', 'a 180-sale MID must not get a verdict');
  want(v('tooEarly').verdict === 'too-early', 'inside the lag window there is no verdict');
  want(v('noReport').verdict === 'no-report-since', 'a fix newer than the report has nothing to measure');
  want(v('missing').verdict === 'missing', 'a MID absent from the report must say so');

  want(R.liveAfterSync.controlsFound.track, 'the + control was not rendered');
  want(R.liveAfterSync.controlsFound.status, 'the status buttons were not rendered — the row never appeared');
  want(R.liveAfterSync.controlsFound.action, 'the action dropdown was not rendered');
  want(R.liveAfterSync.beforeTick === false, 'the row should start untracked');
  want(R.liveAfterSync.ticked, 'the + button must tick immediately after a folder sync, without a reload');
  want(R.liveAfterSync.status === 'doing', 'the status button must move the row after a folder sync');
  want(R.liveAfterSync.statusLit, 'the clicked status button must show as selected');
  want(R.liveAfterSync.action === 'MC Fix (Descriptor Lookup)',
       'the action dropdown must stick after a folder sync');
  want(R.liveAfterSync.selShows === 'MC Fix (Descriptor Lookup)',
       'the dropdown must re-render showing the chosen action');
  want(R.liveAfterSync.teamRowKept, 'a local edit must not drop the team row');
  want(R.liveAfterSync.buckets.length >= 1, 'tracker rows must show the bucket');

  want(R.reclaim.before === 4, 'expected 4 events written, got ' + R.reclaim.before);
  want(R.reclaim.adopted === 4, 'sync must reclaim this device\'s own events, adopted ' + R.reclaim.adopted);
  want(R.reclaim.after > R.reclaim.before,
       'the file must grow, not truncate: ' + R.reclaim.before + ' -> ' + R.reclaim.after);
  want(R.reclaim.uniqueIds, 'reclaimed events must not collide with newly issued ids');
  want(R.reclaim.rowsVisible === 3, 'all three tracked MIDs should survive the reclaim');

  want(R.merge.action === 'MC Fix (Descriptor Lookup)', 'the later action should win the merge');
  want(R.merge.status === 'done', 'the later status should win the merge');
  want(R.merge.hasBaseline, 'the winning done event must carry its baseline');
  want(R.merge.orderIndependent, 'the fold must not depend on the order files are read in');
  want(R.untrack === 0, 'untrack must remove the row');

  want(R.exportShape.cols === 27, 'tracker export should be 27 columns, got ' + R.exportShape.cols);
  want(R.exportShape.first20 ===
       'Action|Bucket|Merch.|DBA|MID|# Sales|$ Sales|CB #|CB Volume|CB %|$ Refunds|Refund %|MC|Visa|# RDR|RDR Coverage %|Amex|Disc|Tier|Action',
       'the first 20 columns must match the workbook exactly');
  want(R.exportShape.midIsText, 'MID must be written as text, got ' + R.exportShape.midCell);
  want(R.exportShape.csvHasTextWrapper, 'the CSV must carry the same text wrapper as the TSV');
  want(R.auditExportUnchanged.cols === 21, 'the audit export must stay at 21 columns');
  want(R.auditExportUnchanged.order ===
       'Tier|Flags|Primary|Action|Bucket|Merchant|DBA|MID|# Sales|$ Sales|CB #|CB Volume|CB %|$ Refunds|Refund %|MC|Visa|# RDR|RDR Coverage %|Amex|Disc',
       'the audit export order must not drift');

  const RO = R.readOnly;
  want(RO.ownerCanTrack, 'an owner must be able to track');
  want(RO.ownerRole.writable === true && RO.ownerRole.viewer === false,
       'a writable folder must read as owner, got ' + JSON.stringify(RO.ownerRole));
  want(RO.probeDetects, 'probe must detect a folder that hands out a handle then refuses the write');
  want(RO.viewerRole.viewer === true && RO.viewerRole.canWrite === false,
       'a read-only folder must read as viewer, got ' + JSON.stringify(RO.viewerRole));
  want(RO.probeCleanedUp, 'the probe file must never be left behind in a shared folder');
  want(RO.teamRowVisible, 'a viewer must still see what the team is tracking');
  want(RO.eventsAdded === 0,
       'a viewer must record nothing locally, got ' + RO.eventsAdded + ' events');
  want(RO.statusUnchanged === 'required',
       'a viewer click must not change the folded state, got ' + RO.statusUnchanged);
  want(RO.statusButtons === 0, 'no status buttons in read-only, got ' + RO.statusButtons);
  want(RO.actionSelects === 0, 'no action dropdowns in read-only, got ' + RO.actionSelects);
  want(RO.removeButtons === 0, 'no remove buttons in read-only, got ' + RO.removeButtons);
  want(RO.trackButtons === 0, 'no + track buttons in read-only, got ' + RO.trackButtons);
  want(RO.readOnlyLabels > 0, 'read-only rows must still show action and status as text');
  want(RO.stripButtons.indexOf('Save audit') < 0,
       'Save audit must be hidden in read-only, got ' + JSON.stringify(RO.stripButtons));
  want(RO.badge, 'the folder strip must say View only');
  want(RO.saveThrew, 'FOLDER.writeFile must refuse a read-only folder, not just hide the button');
  want(RO.controlsReturn, 'controls must return when write access returns');
  want(RO.writesResume === 1, 'writing must resume, got ' + RO.writesResume + ' events');
  want(RO.forcedViewer, 'the explicit override must force read-only on a writable folder');
  want(RO.forcedBlocks === 0, 'the forced viewer must record nothing, got ' + RO.forcedBlocks);
  want(RO.restored, 'clearing the override must restore write access');

  console.log('\ntracker assertions        : ' + (fail.length ? fail.length + ' FAILED' : '0 failures'));
  fail.forEach(f => console.log('  FAIL  ' + f));

  await browser.close();
  process.exit(fail.length ? 1 : 0);
})();
