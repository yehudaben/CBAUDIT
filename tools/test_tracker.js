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

  /* ---- 9. folder roles ----
     Three roles, detected from two folders. The middle one is the point: on a
     shared drive a folder can be shared to grant MORE access than the member
     holds at drive level, so a team of Viewers can hold Contributor on
     tracker/ alone — able to move a status, unable to add an export, save an
     audit, or change which deals are tracked.

     Step 4c left FOLDER.handle as a bare stub, so this installs a handle of
     its own: one that hands out a file handle and then refuses the write,
     which is exactly how a read-only synced drive behaves, with root and
     tracker/ carrying separate flags. */
  R.roles = await page.evaluate(async (mids) => {
    const [FAT, THIN, APEX] = mids;
    const out = {}, tfiles = {};
    const mkdir = (own) => ({
      __files: {},
      async getFileHandle(n, o){
        const d = this;
        if ((!o || !o.create) && !(n in d.__files)) {
          const e = new Error('not found'); e.name = 'NotFoundError'; throw e;
        }
        return {async createWritable(){
          if (own()) { const e = new Error('read-only'); e.name = 'NotAllowedError'; throw e; }
          return {async write(b){ d.__files[n] = b.size || 0; }, async close(){}};
        }};
      },
      async removeEntry(n){ delete this.__files[n]; }
    });
    const H = {__ro: false, __roTracker: false};
    Object.assign(H, mkdir(() => H.__ro));
    const TD = mkdir(() => H.__roTracker);
    H.getDirectoryHandle = async (n, o) => {
      if (n === FOLDER.TRACK_DIR) return TD;
      const e = new Error('no dir'); e.name = 'NotFoundError'; throw e;
    };
    FOLDER.handle = H; FOLDER.state = 'connected'; FOLDER.name = 'TestFolder';
    FOLDER.writeTracker = async (n, x) => {
      if (!FOLDER.canTrackWrite()) throw new Error('read-only');
      tfiles[n] = x; return n;
    };
    FOLDER.readTracker = async () => Object.keys(tfiles).map(n => ({name: n, text: tfiles[n]}));

    const controls = () => {
      window.__setView('tracker');
      const c = {
        status: document.querySelectorAll('[data-status-for]').length,
        action: document.querySelectorAll('[data-action-for]').length,
        remove: document.querySelectorAll('[data-untrack]').length
      };
      /* the + toggle is on the AUDIT page — counting it on the tracker page
         reads zero for every role and proves nothing */
      window.__setView('audit');
      c.track    = document.querySelectorAll('[data-track]').length;
      c.staticOn = document.querySelectorAll('.trk.on.ro').length;
      c.blank    = document.querySelectorAll('.trk.ph').length;
      window.__setView('tracker');
      return c;
    };

    /* ---- owner: both folders writable ---- */
    await window.__mockAccess(true, true);
    TRACKER.mine = []; TRACKER.all = []; TRACKER.seq = 0; TRACKER.fold();
    window.__track(FAT, 'Watch');
    window.__track(THIN, 'Watch');
    const THIN_TRACKED = THIN;
    await TRACKER.flush();
    out.owner = {role: window.__folderRole(),
                 tracked: window.__tracker().rows.length,
                 strip: window.__strip().buttons};
    window.__setView('tracker');
    out.owner.controls = controls();

    /* ---- contributor: root read-only, tracker/ writable ---- */
    out.contributorRole = await window.__mockAccess(false, true);
    out.contributor = {role: window.__folderRole()};
    /* a status moves, and it reaches the folder */
    const b1 = window.__trackerEvents().length;
    window.__trackStatus(FAT, 'doing');
    await TRACKER.flush();
    out.contributor.statusEvents = window.__trackerEvents().length - b1;
    out.contributor.statusTook   = (window.__tracker().rows.find(r => r.mid === FAT) || {}).status;
    out.contributor.reachedFolder = Object.keys(tfiles).length > 0 &&
      Object.values(tfiles).join('').indexOf('"doing"') >= 0;
    /* a contributor runs the tracker: adding a merchant and retargeting the
       action both work, and both reach the folder */
    const b2 = window.__trackerEvents().length;
    window.__track(APEX, 'Watch');
    window.__trackAction(FAT, 'Agent Flag');
    out.contributor.addEvents   = window.__trackerEvents().length - b2;
    out.contributor.added       = !!window.__tracker().rows.find(r => r.mid === APEX);
    out.contributor.actionMoved = (window.__tracker().rows.find(r => r.mid === FAT) || {}).action;
    await TRACKER.flush();
    out.contributor.addReachedFolder = Object.values(tfiles).join('').indexOf(APEX) >= 0;

    /* removal is the one thing they cannot do — same line the drive draws */
    const bRem = window.__trackerEvents().length;
    window.__untrack(THIN_TRACKED);
    out.contributor.removeEvents = window.__trackerEvents().length - bRem;
    out.contributor.stillTracked = window.__tracker().rows.length;
    window.__setView('tracker');
    out.contributor.controls = controls();
    out.contributor.strip    = window.__strip().buttons;
    out.contributor.badge    = (document.querySelector('.robadge') || {}).textContent;
    try { await FOLDER.writeFile('x.csv', 'a'); out.contributor.auditThrew = false; }
    catch (e) { out.contributor.auditThrew = /read-only/i.test(e.message); }

    /* ---- viewer: neither writable ---- */
    out.viewerRole = await window.__mockAccess(false, false);
    out.viewer = {role: window.__folderRole()};
    const b3 = window.__trackerEvents().length;
    window.__trackStatus(FAT, 'done');
    out.viewer.statusEvents = window.__trackerEvents().length - b3;
    out.viewer.teamRowVisible = !!window.__tracker().rows.find(r => r.mid === FAT);
    window.__setView('tracker');
    out.viewer.controls = controls();
    out.viewer.strip    = window.__strip().buttons;
    out.viewer.badge    = (document.querySelector('.robadge') || {}).textContent;

    /* ---- back to owner: everything returns ---- */
    await window.__mockAccess(true, true);
    window.__setView('tracker');
    out.restored = {role: window.__folderRole().role, controls: controls()};
    const b4 = window.__trackerEvents().length;
    window.__trackAction(FAT, 'Agent Flag');
    out.restored.writesResume = window.__trackerEvents().length - b4;

    /* ---- the preference may narrow, never widen ---- */
    await window.__setRolePref('contributor');
    out.narrowed = window.__folderRole().role;
    const b5 = window.__trackerEvents().length;
    window.__untrack(FAT);                       /* the one op a contributor lacks */
    out.narrowedBlocks = window.__trackerEvents().length - b5;
    await window.__mockAccess(false, false);          /* folder says viewer... */
    await window.__setRolePref('contributor');        /* ...preference says more */
    out.cannotWiden = window.__folderRole().role;
    await window.__setRolePref('auto');
    await window.__mockAccess(true, true);
    out.finalRole = window.__folderRole().role;
    return out;
  }, [M_FAT, M_THIN, M_APEX]);

  /* ---- 10. problem-family colour on the tracker ----
     The board is grouped by action and an action IS a family, so the same
     three colours the audit card uses can carry across. Asserted from the
     rendered DOM rather than from the map, because a map with no CSS behind
     it looks correct and shows nothing. */
  R.colour = await page.evaluate(async mids => {
    const [FAT, THIN, APEX] = mids;
    await window.__mockAccess(true, true);
    TRACKER.mine = []; TRACKER.all = []; TRACKER.seq = 0; TRACKER.fold();
    window.__track(FAT,  'MC Fix (Descriptor Lookup)');
    window.__track(THIN, 'RDR Fix (ARN Lookup)');
    window.__track(APEX, 'Agent Flag');
    window.__setView('tracker');
    const board = window.__trackerColours();
    /* every family must also be a real painted rail, not just a class name */
    const seen = {};
    document.querySelectorAll('.agrp').forEach(g => {
      const m = String(g.className).match(/fam-(rdr|mc|gen)/);
      if (m) seen[m[1]] = getComputedStyle(g).borderLeftColor;
    });
    return {map: {mc: window.__famOf('MC Fix (Descriptor Lookup)'),
                  rdr: window.__famOf('RDR Fix (ARN Lookup)'),
                  agent: window.__famOf('Agent Flag'),
                  watch: window.__famOf('Watch'),
                  unknown: window.__famOf('Something Else')},
            groups: board.groups.map(g => g.cls).sort(),
            rowsAllTagged: board.rows.length > 0 && board.rows.every(Boolean),
            railColours: seen,
            distinctRails: [...new Set(Object.values(seen))].length};
  }, [M_FAT, M_THIN, M_APEX]);

  /* ---- 11. backdating the measurement date ----
     A fix that landed before anyone ticked it off has to be measurable from
     when it actually landed. The baseline must then come from a report that
     existed on that date — not from today's numbers wearing an older label. */
  /* backdating needs a library with older reports in it — the whole point is
     reading a baseline from a report that existed on the chosen date */
  const fxNames = ['fx_2026-07-24-0900.csv', 'fx_2026-07-31-2300.csv',
                   'fx_2026-08-05-0900.csv', 'fx_2026-08-14-0901.csv'];
  const fx = fxNames.map(n => ({name: n, text: fs.readFileSync(path.join(FIX, n), 'utf8')}));
  R.backdate = await page.evaluate(async ({mids, fx}) => {
    const [FAT] = mids;
    const out = {};
    fx.forEach(f => window.__loadForTest(f.text, f.name));
    await new Promise(r => setTimeout(r, 300));
    const stamps = window.__lib().map(s => s.stamp).sort();
    out.reports = stamps;

    TRACKER.mine = []; TRACKER.all = []; TRACKER.seq = 0; TRACKER.fold();
    window.__track(FAT, 'Watch');
    window.__trackStatus(FAT, 'done');                 /* done "today" */
    const fresh = window.__outcome(FAT);
    out.today = {verdict: fresh.verdict, baseStamp: fresh.baseStamp,
                 doneAt: String(fresh.doneAt || '').slice(0, 10),
                 elapsed: fresh.elapsedDays};

    /* move it back to a date an older report covers */
    const r = window.__trackDoneAt(FAT, '2026-07-25T12:00:00');
    out.moved = {ok: r.ok, err: r.err};
    const back = window.__outcome(FAT);
    out.backdated = {verdict: back.verdict, baseStamp: back.baseStamp,
                     doneAt: String(back.doneAt || '').slice(0, 10),
                     elapsed: back.elapsedDays, base: back.base, now: back.now};

    /* the baseline must be the newest report AT OR BEFORE that date */
    out.baselineIsOlderReport = String(back.baseStamp || '').slice(0, 10) <= '2026-07-25';

    /* ts must stay the real write time — the fold orders by it */
    const evs = window.__trackerEvents();
    const doneEv = evs.filter(e => e.op === 'status' && e.value === 'done').pop();
    out.event = {hasAt: !!doneEv.at,
                 atDay: String(doneEv.at || '').slice(0, 10),
                 tsIsNotBackdated: String(doneEv.ts).slice(0, 4) !== '2026'
                                   || doneEv.ts !== doneEv.at};

    /* a date older than every report cannot be honoured — no baseline exists */
    const tooOld = window.__trackDoneAt(FAT, '2020-01-01T12:00:00');
    out.tooOld = {ok: tooOld.ok, noReport: tooOld.noReport};
    const still = window.__outcome(FAT);
    out.unchangedAfterRefusal = String(still.baseStamp || '').slice(0, 10)
                                === out.backdated.baseStamp.slice(0, 10);

    window.__setView('tracker');
    VIEW.trackTab = 'outcomes'; render();
    out.dateInputs = document.querySelectorAll('[data-doneat-for]').length;
    out.showsBaselineSource = !!document.querySelector('.mfrom .bsrc');
    return out;
  }, {mids: [M_FAT], fx});

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

  const RL = R.roles;
  want(RL.owner.role.role === 'owner', 'both folders writable must read as owner');
  want(RL.owner.tracked === 2, 'the owner must be able to track, got ' + RL.owner.tracked);
  want(RL.owner.strip.indexOf('Save audit') >= 0, 'the owner keeps Save audit');
  want(RL.owner.controls.action > 0 && RL.owner.controls.remove > 0,
       'the owner keeps every tracker control');

  want(RL.contributorRole === 'contributor',
       'root read-only + tracker writable must read as contributor, got ' + RL.contributorRole);
  want(RL.contributor.statusEvents === 1,
       'a contributor must be able to move a status, got ' + RL.contributor.statusEvents);
  want(RL.contributor.statusTook === 'doing',
       'the status must actually take, got ' + RL.contributor.statusTook);
  want(RL.contributor.reachedFolder, 'a contributor status must reach the folder, not just the board');
  want(RL.contributor.addEvents === 2,
       'a contributor must be able to add a merchant and set its action, got '
       + RL.contributor.addEvents + ' events');
  want(RL.contributor.added, 'the added merchant must appear on the board');
  want(RL.contributor.addReachedFolder,
       'a contributor-added merchant must reach the folder, not just the board');
  want(RL.contributor.actionMoved === 'Agent Flag',
       'a contributor must be able to retarget the action, got ' + RL.contributor.actionMoved);
  want(RL.contributor.removeEvents === 0,
       'removal must refuse for a contributor, got ' + RL.contributor.removeEvents + ' events');
  want(RL.contributor.stillTracked === 3,
       'nothing may be removed under a contributor, got ' + RL.contributor.stillTracked + ' rows');
  want(RL.contributor.controls.status > 0, 'a contributor keeps the status buttons');
  want(RL.contributor.controls.action > 0, 'a contributor keeps the action dropdown');
  want(RL.contributor.controls.remove === 0, 'a contributor gets no Remove');
  want(RL.contributor.controls.track > 0,
       'a contributor keeps the + on untracked audit rows, got ' + RL.contributor.controls.track);
  want(RL.contributor.controls.staticOn > 0,
       'an already-tracked row must show a static tick, not a toggle that would refuse');
  want(RL.viewer.controls.track === 0, 'a viewer gets no + at all');
  want(RL.owner.controls.track > 0, 'the owner keeps the +');
  want(RL.contributor.strip.indexOf('Save audit') < 0, 'a contributor cannot save an audit');
  want(RL.contributor.badge === 'Tracker only',
       'the strip must say Tracker only, got ' + RL.contributor.badge);
  want(RL.contributor.auditThrew, 'writeFile must refuse a contributor at the FOLDER layer');

  want(RL.viewerRole === 'viewer', 'neither folder writable must read as viewer');
  want(RL.viewer.statusEvents === 0,
       'a viewer must record nothing, got ' + RL.viewer.statusEvents);
  want(RL.viewer.teamRowVisible, 'a viewer must still see what the team is tracking');
  want(RL.viewer.controls.status === 0 && RL.viewer.controls.action === 0
       && RL.viewer.controls.remove === 0 && RL.viewer.controls.track === 0,
       'a viewer gets no tracker controls at all');
  want(RL.viewer.badge === 'View only', 'the strip must say View only, got ' + RL.viewer.badge);

  want(RL.restored.role === 'owner', 'write access returning must restore owner');
  want(RL.restored.controls.action > 0, 'controls must return with write access');
  want(RL.restored.writesResume === 1, 'writing must resume, got ' + RL.restored.writesResume);

  want(RL.narrowed === 'contributor', 'the preference must be able to narrow owner to contributor');
  want(RL.narrowedBlocks === 0, 'a narrowed browser must be held to its role');
  want(RL.cannotWiden === 'viewer',
       'the preference must never widen past the folder, got ' + RL.cannotWiden);
  want(RL.finalRole === 'owner', 'clearing the preference must restore the detected role');

  const C = R.colour;
  want(C.map.mc === 'mc' && C.map.rdr === 'rdr' && C.map.agent === 'gen'
       && C.map.watch === 'gen', 'action must map to the card families, got '
       + JSON.stringify(C.map));
  want(C.map.unknown === 'gen', 'an unknown action must fall back, not go blank');
  want(JSON.stringify(C.groups) === JSON.stringify(['gen', 'mc', 'rdr']),
       'each action group must carry its family, got ' + JSON.stringify(C.groups));
  want(C.rowsAllTagged, 'every tracker row must carry a family class');
  want(C.distinctRails === 3,
       'the three families must paint three DIFFERENT rails, got '
       + C.distinctRails + ': ' + JSON.stringify(C.railColours));

  const B = R.backdate;
  want(B.reports.length >= 2, 'this test needs several reports, got ' + B.reports.length);
  /* "today" is after the newest export, so the honest answer is that there is
     no evidence yet — a different problem from waiting out the lag, and the
     exact state that sends someone looking for this override */
  want(B.today.verdict === 'no-report-since',
       'done-today with an older newest report must read no-report-since, got '
       + B.today.verdict);
  want(B.moved.ok, 'backdating must succeed: ' + B.moved.err);
  want(B.backdated.doneAt === '2026-07-25',
       'the measurement date must move, got ' + B.backdated.doneAt);
  want(B.baselineIsOlderReport,
       'the baseline must come from a report at or before that date, got '
       + B.backdated.baseStamp);
  want(B.backdated.elapsed > B.today.elapsed,
       'backdating must lengthen the elapsed window, got '
       + B.backdated.elapsed + ' vs ' + B.today.elapsed);
  want(['improved', 'worse', 'flat', 'thin'].indexOf(B.backdated.verdict) >= 0,
       'with the lag elapsed the outcome must be reported or denominator-gated, got '
       + B.backdated.verdict);
  want(B.event.hasAt && B.event.atDay === '2026-07-25',
       'the event must carry the effective date, got ' + JSON.stringify(B.event));
  want(B.event.tsIsNotBackdated,
       'ts must stay the real write time — the fold orders by it');
  want(!B.tooOld.ok && B.tooOld.noReport,
       'a date older than every report must be refused, not guessed');
  want(B.unchangedAfterRefusal, 'a refused date must leave the baseline alone');
  want(B.dateInputs > 0, 'the outcomes tab must offer the date control');
  want(B.showsBaselineSource, 'the row must say which report the baseline came from');

  console.log('\ntracker assertions        : ' + (fail.length ? fail.length + ' FAILED' : '0 failures'));
  fail.forEach(f => console.log('  FAIL  ' + f));

  await browser.close();
  process.exit(fail.length ? 1 : 0);
})();
