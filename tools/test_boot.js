const {chromium} = require('playwright') ;
const fs = require('fs');
/* Resolve paths and the target URL from the environment so this runs
   anywhere: BASE_URL to point at a served copy, SAMPLE_CSV for the
   portal export to test against (kept out of git — see fixtures/). */
const path = require('path');
const BASE   = process.env.BASE_URL   || 'http://127.0.0.1:8111';
const ROOT   = path.resolve(__dirname, '..');
const FIX    = process.env.FIXTURES   || path.join(ROOT, 'fixtures');
const SAMPLE = process.env.SAMPLE_CSV || path.join(FIX, 'sample.csv');
/* Use a preinstalled Chromium when CHROMIUM points at one, otherwise let
   Playwright use the browser it downloaded itself. */
const LAUNCH = process.env.CHROMIUM ? {executablePath: process.env.CHROMIUM} : {};

(async () => {
  const browser = await chromium.launch(LAUNCH);
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const errs = [], reqs = [];
  page.on('pageerror', e => errs.push('PAGEERROR: ' + e.message));
  page.on('console', m => { if(m.type()==='error') errs.push('CONSOLE: ' + m.text()); });
  page.on('request', r => reqs.push(r.method()+' '+r.url()));

  const R = {};
  await page.goto(BASE + '/index.html', {waitUntil:'networkidle'});

  R.bootErrors = errs.slice();
  R.version = await page.evaluate(() => window.__VERSION && window.__VERSION());
  R.chip = await page.textContent('#vchip');
  R.banner_hidden_at_boot = await page.evaluate(() =>
    !document.getElementById('updbar').classList.contains('on'));
  R.version_json_fetched = reqs.filter(u => u.includes('version.json')).length;
  R.external_hosts = [...new Set(reqs.map(u => new URL(u.split(' ')[1]).host))];

  // ---- load the real sample and confirm the numbers are untouched
  const csv = fs.readFileSync(SAMPLE,'utf8');
  await page.evaluate(t => window.__loadForTest(t, '2026-08-14-0901.csv'), csv);
  await page.waitForTimeout(900);
  R.afterLoadErrors = errs.slice(R.bootErrors.length);
  R.rowCount = await page.evaluate(() => window.__lib()[0].rows);
  R.trend = await page.evaluate(() => window.__trend());
  R.footerHasBuild = await page.evaluate(() =>
    (document.getElementById('foot').textContent||'').includes('Console v'));

  // ---- simulate a new deployment: version.json now says something else
  await page.evaluate(() => {
    const real = window.fetch;
    window.fetch = (u, o) => (String(u).indexOf('version.json') >= 0)
      ? Promise.resolve(new Response('{"version":"2099.01.01","notes":"Test build."}',
          {status:200, headers:{'Content-Type':'application/json'}}))
      : real(u, o);
  });
  await page.evaluate(() => window.__UPDATE.check());
  await page.waitForTimeout(400);
  R.banner_shows_on_new_version = await page.evaluate(() =>
    document.getElementById('updbar').classList.contains('on'));
  R.banner_text = (await page.textContent('#updmsg')||'').trim();

  // ---- "Later" dismisses it
  await page.click('#btnUpdLater');
  R.banner_dismissable = await page.evaluate(() =>
    !document.getElementById('updbar').classList.contains('on'));

  R.finalErrors = errs;
  console.log(JSON.stringify(R, null, 2));
  await browser.close();
})();
