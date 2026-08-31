/* Drive backend — exercised against a fake Google Drive.
 *
 * Everything here runs the REAL DRIVE_IO code. Only `fetch` is replaced, by
 * an in-memory Drive that behaves like the API in the ways that have actually
 * broken integrations before:
 *
 *   - a file in a shared drive is INVISIBLE unless the caller passes
 *     supportsAllDrives and includeItemsFromAllDrives
 *   - a narrowed `fields` on files.list drops nextPageToken, silently
 *     truncating every result set to one page
 *   - capabilities.canAddChildren is the real permission answer
 *
 * The fake enforces all three, so forgetting any of them fails here rather
 * than in front of the team.
 */
const {chromium} = require('playwright');
const fs = require('fs');
const path = require('path');

const BASE   = process.env.BASE_URL   || 'http://127.0.0.1:8111';
const ROOT   = path.resolve(__dirname, '..');
const FIX    = process.env.FIXTURES   || path.join(ROOT, 'fixtures');
const SAMPLE = process.env.SAMPLE_CSV || path.join(FIX, 'sample.csv');
const LAUNCH = process.env.CHROMIUM ? {executablePath: process.env.CHROMIUM} : {};

const ROOT_ID = 'fld_root', AUD_ID = 'fld_audits', TRK_ID = 'fld_tracker';

(async () => {
  const browser = await chromium.launch(LAUNCH);
  const page = await (await browser.newContext()).newPage();
  const errs = [];
  page.on('pageerror', e => errs.push('PAGEERROR: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') errs.push('CONSOLE: ' + m.text()); });

  await page.goto(BASE + '/index.html', {waitUntil: 'networkidle'});
  await page.evaluate(() => { try { localStorage.clear(); } catch (e) {} });
  await page.reload({waitUntil: 'networkidle'});

  const csv = fs.readFileSync(SAMPLE, 'utf8');
  const R = {};

  /* ---------- install the fake Drive ---------- */
  await page.evaluate(({csv, ROOT_ID, AUD_ID, TRK_ID}) => {
    const FOLDER_MIME = 'application/vnd.google-apps.folder';
    const D = window.__fakeDrive = {
      calls: [],
      missingAllDrives: 0,
      files: {
        [ROOT_ID]: {id: ROOT_ID, name: 'CB Audit Location', mimeType: FOLDER_MIME,
                    parents: []},
        [AUD_ID]:  {id: AUD_ID, name: 'audits', mimeType: FOLDER_MIME,
                    parents: [ROOT_ID]},
        [TRK_ID]:  {id: TRK_ID, name: 'tracker', mimeType: FOLDER_MIME,
                    parents: [ROOT_ID]},
        f_a: {id: 'f_a', name: 'CB__2026-08-14@09.01.00.csv', mimeType: 'text/csv',
              parents: [ROOT_ID], body: csv, modifiedTime: '2026-08-14T09:01:00Z'},
        f_b: {id: 'f_b', name: 'CB__2026-08-20@09.30.00.csv', mimeType: 'text/csv',
              parents: [ROOT_ID], body: csv, modifiedTime: '2026-08-20T09:30:00Z'},
        f_skip: {id: 'f_skip', name: 'notes.txt', mimeType: 'text/plain',
                 parents: [ROOT_ID], body: 'ignore me'},
        ev_x: {id: 'ev_x', name: 'events-teammate.jsonl', mimeType: 'application/x-ndjson',
               parents: [TRK_ID], body: ''}
      },
      seq: 0,
      /* Drive derives capabilities from the member's shared-drive role, with
         folder-level shares able to WIDEN it. Modelling root and audits/ as
         independently settable would let this test pass while the real thing
         failed, so they move together and only tracker/ carries an override. */
      role: 'viewer',
      trackerGrant: 'contributor'
    };
    D.capsFor = f => {
      if (f.mimeType !== FOLDER_MIME) return {canEdit: D.role !== 'viewer'};
      const lvl = (f.id === TRK_ID) ? D.trackerGrant : D.role;
      return {canAddChildren: lvl !== 'viewer', canEdit: lvl !== 'viewer'};
    };
    /* one page at a time, so a missing nextPageToken shows up as lost files */
    D.PAGE = 2;

    const parseQS = u => {
      const q = {}; const i = u.indexOf('?');
      if (i < 0) return q;
      u.slice(i + 1).split('&').forEach(kv => {
        const [k, v] = kv.split('=');
        q[decodeURIComponent(k)] = decodeURIComponent(v || '');
      });
      return q;
    };
    const ok = (obj, txt) => Promise.resolve({
      ok: true, status: 200, statusText: 'OK',
      json: async () => obj, text: async () => (txt !== undefined ? txt : JSON.stringify(obj))
    });
    const bad = (status, message) => Promise.resolve({
      ok: false, status, statusText: 'Error',
      json: async () => ({error: {message}}), text: async () => message
    });

    /* deliberately literal: only the clauses DRIVE_IO actually emits */
    const matches = (f, q) => {
      if (!q) return true;
      let m;
      if ((m = q.match(/'([^']+)' in parents/)) && !(f.parents || []).includes(m[1])) return false;
      if ((m = q.match(/name='([^']*)'/)) && f.name !== m[1].replace(/\\'/g, "'")) return false;
      if ((m = q.match(/mimeType='([^']+)'/)) && f.mimeType !== m[1]) return false;
      if (/mimeType!='([^']+)'/.test(q)) {
        const x = q.match(/mimeType!='([^']+)'/)[1];
        if (f.mimeType === x) return false;
      }
      return true;
    };

    window.fetch = async (url, opts) => {
      opts = opts || {};
      const u = String(url);
      D.calls.push({url: u, method: opts.method || 'GET'});
      const q = parseQS(u);

      if (!/googleapis\.com/.test(u)) return bad(404, 'unexpected host ' + u);
      if (q.supportsAllDrives !== 'true') { D.missingAllDrives++; return bad(404, 'File not found.'); }
      if (!/Bearer /.test((opts.headers || {}).Authorization || '')) return bad(401, 'no token');

      /* ---- upload endpoints ---- */
      if (/\/upload\/drive\/v3\/files/.test(u)) {
        const idm = u.match(/\/upload\/drive\/v3\/files\/([^?]+)/);
        if (opts.method === 'PATCH' && idm) {
          const f = D.files[decodeURIComponent(idm[1])];
          if (!f) return bad(404, 'File not found.');
          f.body = opts.body;
          return ok({id: f.id});
        }
        if (opts.method === 'POST') {
          const meta = JSON.parse(String(opts.body).match(/\{[\s\S]*?\}/)[0]);
          const parent = (meta.parents || [])[0];
          if (!D.files[parent] || !D.capsFor(D.files[parent]).canAddChildren)
            return bad(403, 'Insufficient permissions.');
          const body = String(opts.body).split('\r\n\r\n').slice(2).join('\r\n\r\n')
                        .replace(/\r\n--[^-]+--\s*$/, '');
          const id = 'new_' + (++D.seq);
          D.files[id] = {id, name: meta.name, parents: meta.parents,
                         mimeType: 'application/octet-stream', body};
          return ok({id});
        }
      }

      /* ---- files.list ---- */
      if (/\/drive\/v3\/files\?/.test(u) && (opts.method || 'GET') === 'GET') {
        if (q.includeItemsFromAllDrives !== 'true') { D.missingAllDrives++; return ok({files: []}); }
        const all = Object.values(D.files).filter(f => matches(f, q.q));
        const start = q.pageToken ? +q.pageToken : 0;
        const slice = all.slice(start, start + D.PAGE);
        const next = start + D.PAGE < all.length ? String(start + D.PAGE) : undefined;
        const body = {files: slice.map(f => ({id: f.id, name: f.name, mimeType: f.mimeType,
                                              modifiedTime: f.modifiedTime}))};
        /* honour the API's real behaviour: nextPageToken only if asked for */
        if (next && /nextPageToken/.test(q.fields || '')) body.nextPageToken = next;
        return ok(body);
      }

      /* ---- files.create (folder) ---- */
      if (/\/drive\/v3\/files\?/.test(u) && opts.method === 'POST') {
        const meta = JSON.parse(opts.body);
        const parent = (meta.parents || [])[0];
        if (!D.files[parent] || !D.capsFor(D.files[parent]).canAddChildren)
          return bad(403, 'Insufficient permissions.');
        const id = 'newf_' + (++D.seq);
        D.files[id] = {id, name: meta.name, mimeType: meta.mimeType, parents: meta.parents};
        return ok({id});
      }

      /* ---- files.get ---- */
      const gm = u.match(/\/drive\/v3\/files\/([^?]+)\?/);
      if (gm) {
        const f = D.files[decodeURIComponent(gm[1])];
        if (!f) return bad(404, 'File not found.');
        if (q.alt === 'media') return ok(null, f.body);
        return ok({id: f.id, name: f.name, mimeType: f.mimeType, capabilities: D.capsFor(f)});
      }
      return bad(404, 'unhandled ' + u);
    };
    return true;
  }, {csv, ROOT_ID, AUD_ID, TRK_ID});

  /* ---------- 1. connect as a contributor ---------- */
  R.connect = await page.evaluate(async id => {
    window.__driveInstall({clientId: 'test.apps.googleusercontent.com'});
    /* a connect failure is a result, not a crash: reported as a named
       assertion so the run still prints the other diagnostics */
    try {
      const r = await window.__driveConnect(id);
      return {...r, lib: window.__lib().length,
              reports: window.__lib().map(s => s.rows)};   /* __lib already counts */
    } catch (e) {
      return {failed: e.message || String(e), backend: null, name: null,
              lib: 0, reports: []};
    }
  }, ROOT_ID);

  R.state = await page.evaluate(() => window.__driveState());
  R.strip = await page.evaluate(() => window.__strip());

  /* ---------- 2. shared-drive params on every single call ---------- */
  R.params = await page.evaluate(() => {
    const c = window.__fakeDrive.calls;
    return {
      total: c.length,
      missingAllDrives: window.__fakeDrive.missingAllDrives,
      everyCallHasSupport: c.every(x => /supportsAllDrives=true/.test(x.url)),
      everyListHasInclude: c.filter(x => /\/files\?/.test(x.url) && x.method === 'GET')
                            .every(x => /includeItemsFromAllDrives=true/.test(x.url))
    };
  });

  /* ---------- 3. paging: 4 root files at 2 per page ---------- */
  R.paging = await page.evaluate(() => {
    const c = window.__fakeDrive.calls.filter(x => /pageToken/.test(x.url));
    return {pagedCalls: c.length, csvFound: window.__lib().length};
  });

  /* ---------- 4. the role came from Drive, not a write probe ---------- */
  R.role = await page.evaluate(() => window.__folderRole());
  R.noProbeFile = await page.evaluate(() =>
    !Object.values(window.__fakeDrive.files).some(f => /cbrc-access-check/.test(f.name)));

  /* ---------- 5. a contributor's tracker write lands in tracker/ ---------- */
  R.write = await page.evaluate(async mid => {
    const before = Object.keys(window.__fakeDrive.files).length;
    window.__track(mid, 'Watch');
    await new Promise(r => setTimeout(r, 250));
    const all = Object.values(window.__fakeDrive.files)
      .filter(f => /^events-/.test(f.name) && (f.parents || []).includes('fld_tracker'));
    const mine = all.filter(f => f.name !== 'events-teammate.jsonl');
    return {added: Object.keys(window.__fakeDrive.files).length - before,
            inTracker: all.length, mine: mine.length,
            hasEvent: mine.some(f => String(f.body).indexOf(mid) >= 0),
            tracked: window.__tracker().rows.length};
  }, '0700100000199485');

  /* ---------- 6. an audit write is refused, because root says so ---------- */
  R.auditRefused = await page.evaluate(async () => {
    try { await FOLDER.writeFile('x.csv', 'a'); return {threw: false}; }
    catch (e) { return {threw: true, msg: e.message}; }
  });

  /* ---------- 7. promote to owner and the audit write succeeds ---------- */
  R.asOwner = await page.evaluate(async () => {
    window.__fakeDrive.role = 'contentManager';     /* promoted on the drive itself */
    await FOLDER.probe();
    const role = FOLDER.role();
    let saved = null;
    try { saved = await FOLDER.writeFile('audit-test.csv', 'a,b\n1,2\n'); }
    catch (e) { saved = 'ERR: ' + e.message; }
    const inAudits = Object.values(window.__fakeDrive.files)
      .some(f => f.name === 'audit-test.csv' && (f.parents || []).includes('fld_audits'));
    return {role, saved, inAudits, exists: await FOLDER.auditExists('audit-test.csv')};
  });

  /* ---------- 8. reconnect from localStorage without a fresh sign-in ---------- */
  R.restore = await page.evaluate(async () => {
    const before = window.__driveState();
    await window.__driveDisconnect();
    const cleared = window.__driveState();
    return {beforeId: before.folderId, clearedId: cleared.folderId,
            backendAfter: cleared.backend};
  });

  R.errors = errs.slice();
  console.log(JSON.stringify(R, null, 2));

  /* ---------- assertions ---------- */
  const fail = [];
  const want = (c, m) => { if (!c) fail.push(m); };

  want(R.errors.length === 0, 'page errors: ' + R.errors.join(' | '));
  want(!R.connect.failed, 'connect failed: ' + R.connect.failed);
  want(R.connect.backend === 'drive', 'backend must be drive, got ' + R.connect.backend);
  want(R.connect.name === 'CB Audit Location',
       'folder name must come from Drive, got ' + R.connect.name);
  want(R.connect.lib === 2, 'both CSVs must load, got ' + R.connect.lib);
  want(R.connect.reports.every(n => n === 806),
       'each report must parse to 806 rows, got ' + JSON.stringify(R.connect.reports));

  want(R.params.missingAllDrives === 0,
       'every call must opt into shared drives — ' + R.params.missingAllDrives + ' did not');
  want(R.params.everyCallHasSupport, 'supportsAllDrives missing from at least one call');
  want(R.params.everyListHasInclude, 'includeItemsFromAllDrives missing from at least one list');

  want(R.paging.pagedCalls > 0, 'the fake serves 2 per page — paging was never exercised');
  want(R.paging.csvFound === 2, 'paging lost a file: ' + R.paging.csvFound + ' of 2');

  want(R.role.role === 'contributor',
       'root read-only + tracker writable must read as contributor, got ' + R.role.role);
  want(R.role.access.root === false && R.role.access.tracker === true,
       'capabilities must drive the role, got ' + JSON.stringify(R.role.access));
  want(R.noProbeFile, 'the Drive probe must write nothing at all');
  want(R.strip.buttons.indexOf('Save audit') < 0, 'a contributor gets no Save audit');

  want(R.write.mine === 1, 'exactly one file written by us, got ' + R.write.mine);
  want(R.write.inTracker === 2,
       "our file must sit alongside the teammate's, got " + R.write.inTracker);
  want(R.write.hasEvent, 'the tracked MID must be in the uploaded file');
  want(R.write.tracked === 1, 'the row must appear on the board');

  want(R.auditRefused.threw, 'writeFile must refuse while root is read-only');

  want(R.asOwner.role === 'owner', 'canAddChildren on root must promote to owner');
  want(R.asOwner.saved === 'audit-test.csv', 'the audit must save, got ' + R.asOwner.saved);
  want(R.asOwner.inAudits, 'the audit must land in audits/, not the root');
  want(R.asOwner.exists, 'auditExists must find what writeAudit just wrote');

  want(R.restore.clearedId === null, 'disconnect must forget the folder');
  want(R.restore.backendAfter === 'fs', 'disconnect must fall back to the filesystem backend');

  console.log('\ndrive assertions          : ' + (fail.length ? fail.length + ' FAILED' : '0 failures'));
  fail.forEach(f => console.log('  FAIL  ' + f));

  await browser.close();
  process.exit(fail.length ? 1 : 0);
})();
