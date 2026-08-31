/* Processor API pull — the parts that are deterministic.
 *
 * What this proves without a real processor:
 *   - a key is stored in localStorage only, and never in a URL unless the
 *     operator explicitly chose query placement
 *   - the request is built correctly: header vs query, prefix, extra fields
 *   - the key value is masked in the rendered Settings list
 *   - test() classifies each outcome by name — reached / rejected / CORS —
 *     because the fix differs per case and "CORS" must not read as "wrong key"
 *   - mapText refuses non-CSV rather than inventing a mapping
 *
 * What it cannot prove — and does not pretend to — is that a real processor
 * answers, or that its response maps to rows. Both need a real endpoint; the
 * in-app Test button is what surfaces them.
 */
const {chromium} = require('playwright');
const path = require('path');

const BASE   = process.env.BASE_URL || 'http://127.0.0.1:8111';
const LAUNCH = process.env.CHROMIUM ? {executablePath: process.env.CHROMIUM} : {};

(async () => {
  const browser = await chromium.launch(LAUNCH);
  const page = await (await browser.newContext()).newPage();
  const errs = [];
  page.on('pageerror', e => errs.push('PAGEERROR: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') errs.push('CONSOLE: ' + m.text()); });

  await page.goto(BASE + '/index.html', {waitUntil: 'networkidle'});
  await page.evaluate(() => { try { localStorage.clear(); } catch (e) {} });
  await page.reload({waitUntil: 'networkidle'});

  const R = {};

  /* ---------- 1. storage round-trip, and the key is only in localStorage ---------- */
  R.store = await page.evaluate(() => {
    window.__api.reset();
    const id = window.__api.add({
      name: 'Acme', url: 'https://api.acme.test/chargebacks',
      authIn: 'header', authName: 'Authorization', authPrefix: 'Bearer ',
      authValue: 'SUPER-SECRET-KEY-123',
      extra: [{in: 'header', name: 'X-Merchant', value: 'M-42'}]
    });
    const listed = window.__api.list();
    const raw = window.__api.raw();
    return {
      id,
      count: listed.length,
      hasValueFlag: listed[0].hasValue,
      /* the raw store holds the key (it must, to use it) — the point is it is
         localStorage, not the page/DOM/repo */
      rawHoldsKey: raw.indexOf('SUPER-SECRET-KEY-123') >= 0,
      extraCount: listed[0].extra
    };
  });

  /* ---------- 2. request construction ---------- */
  R.header = await page.evaluate(id => {
    const {url, opts} = window.__api.built(id);
    return {url, headers: opts.headers, method: opts.method};
  }, R.store.id);

  R.query = await page.evaluate(() => {
    const id = window.__api.add({
      name: 'QueryStyle', url: 'https://api.two.test/report?from=2026-08-01',
      authIn: 'query', authName: 'api_key', authPrefix: '',
      authValue: 'QKEY', extra: [{in: 'query', name: 'mid', value: '0567'}]
    });
    const built = window.__api.built(id);
    return {url: built.url, headers: built.opts.headers};
  });

  /* ---------- 3. the key is masked in the rendered Settings list ---------- */
  R.masked = await page.evaluate(() => {
    /* the settings view only renders once a report is loaded (render() bails
       on no SNAP_A), so give it a tiny valid one */
    window.__loadForTest('"Bckt","Merch.","DBA","MID","# Sales","$ Sales","Avg Sales",'
      + '"$ Rfnds","% Rfnds","CB #","CB Vol.","% CB","# RDR","$ RDR","Amex","Visa","MC","Disc"\r\n'
      + '"A","Acme","Acme","0567000000788547","100","$1000.00","$10","$0","0%","0","0","0%",'
      + '"0","0","0","0","0","0"\r\n', 't.csv');
    window.__setView('settings');
    const panel = document.querySelector('.apiwrap');
    const html = panel ? panel.innerHTML : '';
    return {
      panelPresent: !!panel,
      leaksKey: html.indexOf('SUPER-SECRET-KEY-123') >= 0,
      hasMaskDots: /•/.test(html)
    };
  });

  /* ---------- 4. test() classifies outcomes by name (stubbed fetch) ---------- */
  R.classify = await page.evaluate(async () => {
    const realFetch = window.fetch;
    const out = {};
    const mk = (impl) => { window.fetch = impl; };

    /* a valid CSV response */
    mk(async () => ({
      ok: true, status: 200,
      headers: {get: () => 'text/csv'},
      text: async () => '"Bckt","Merch.","MID"\r\n"A","B","0567000000788547"\r\n'
    }));
    out.ok = await window.__api.test(window.__api.add({name: 'X', url: 'https://a.test/r'}));

    /* a 401 — key reached but rejected */
    mk(async () => ({
      ok: false, status: 401,
      headers: {get: () => 'application/json'},
      text: async () => '{"error":"invalid key"}'
    }));
    out.rejected = await window.__api.test(window.__api.add({name: 'Y', url: 'https://a.test/r'}));

    /* a fetch that REJECTS — the CORS signature */
    mk(async () => { throw new TypeError('Failed to fetch'); });
    out.cors = await window.__api.test(window.__api.add({name: 'Z', url: 'https://a.test/r'}));

    window.fetch = realFetch;
    return out;
  });

  /* ---------- 5. mapText refuses non-CSV ---------- */
  R.map = await page.evaluate(() => ({
    csv: window.__api.map('"Bckt","Merch."\r\n"A","B"\r\n', 'text/csv'),
    json: window.__api.map('{"rows":[]}', 'application/json')
  }));

  R.errors = errs.slice();
  console.log(JSON.stringify(R, null, 2));

  /* ---------- assertions ---------- */
  const fail = [];
  const want = (c, m) => { if (!c) fail.push(m); };

  want(R.errors.length === 0, 'page errors: ' + R.errors.join(' | '));

  want(R.store.count === 1, 'one connection stored, got ' + R.store.count);
  want(R.store.hasValueFlag, 'the stored connection must carry its key');
  want(R.store.rawHoldsKey, 'the key must be in localStorage (that is where it belongs)');
  want(R.store.extraCount === 1, 'the extra field must be stored, got ' + R.store.extraCount);

  want(R.header.headers.Authorization === 'Bearer SUPER-SECRET-KEY-123',
       'header auth must apply the prefix, got ' + R.header.headers.Authorization);
  want(R.header.headers['X-Merchant'] === 'M-42',
       'the extra header must be applied, got ' + R.header.headers['X-Merchant']);
  want(R.header.url.indexOf('SUPER-SECRET') < 0,
       'a header key must NEVER appear in the URL, got ' + R.header.url);
  want(R.header.method === 'GET', 'method must default to GET');

  want(/[?&]api_key=QKEY/.test(R.query.url),
       'query auth must go in the URL, got ' + R.query.url);
  want(/[?&]mid=0567/.test(R.query.url),
       'an extra query field must go in the URL, got ' + R.query.url);
  want(/[?&]from=2026-08-01/.test(R.query.url),
       'the URL\'s own query must survive, got ' + R.query.url);
  want(!R.query.headers.Authorization,
       'query style must not also set an Authorization header');

  want(R.masked.panelPresent, 'the Settings panel must render');
  want(!R.masked.leaksKey, 'the key must NOT appear in the rendered Settings list');
  want(R.masked.hasMaskDots, 'the list must show a masked placeholder for the key');

  want(R.classify.ok.kind === 'ok', 'a 200 CSV must classify as ok, got ' + R.classify.ok.kind);
  want(R.classify.ok.looksCsv, 'a CSV body must be recognised as CSV');
  want(R.classify.rejected.kind === 'http' && R.classify.rejected.status === 401,
       'a 401 must classify as http/401, got ' + JSON.stringify(R.classify.rejected.kind));
  want(/rejected|wrong key|lacks access/i.test(R.classify.rejected.msg),
       'a 401 message must say the key was rejected, not blame CORS');
  want(R.classify.cors.kind === 'cors',
       'a fetch rejection must classify as CORS, got ' + R.classify.cors.kind);
  want(/CORS/i.test(R.classify.cors.msg) && /cannot fix/i.test(R.classify.cors.msg),
       'the CORS message must name CORS and say a key cannot fix it');

  want(R.map.csv.csv && !R.map.csv.error, 'portal-shaped CSV must pass through mapText');
  want(!!R.map.json.error, 'non-CSV must be refused, not mis-parsed');

  console.log('\napi-pull assertions       : ' + (fail.length ? fail.length + ' FAILED' : '0 failures'));
  fail.forEach(f => console.log('  FAIL  ' + f));

  await browser.close();
  process.exit(fail.length ? 1 : 0);
})();
