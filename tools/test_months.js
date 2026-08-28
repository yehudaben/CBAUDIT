const {chromium} = require('playwright');
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
  const b = await chromium.launch(LAUNCH);
  const page = await (await b.newContext()).newPage();
  const errs = [];
  page.on('pageerror', e => errs.push('PAGEERROR: '+e.message));
  page.on('console', m => { if(m.type()==='error') errs.push('CONSOLE: '+m.text()); });

  await page.goto(BASE + '/index.html', {waitUntil:'networkidle'});
  const R = {bootErrors: errs.slice()};

  const files = ['fx_2026-07-24-0900.csv','fx_2026-07-31-2300.csv',
                 'fx_2026-08-05-0900.csv','fx_2026-08-14-0901.csv'];
  for(const f of files){
    const t = fs.readFileSync(path.join(FIX,f),'utf8');
    await page.evaluate(([txt,name]) => window.__loadForTest(txt,name), [t,f]);
    await page.waitForTimeout(250);
  }
  await page.waitForTimeout(600);
  R.loadErrors = errs.slice(R.bootErrors.length);

  R.lib = await page.evaluate(()=>window.__lib().map(s=>s.stamp));
  R.trend = await page.evaluate(()=>window.__trend());

  await page.evaluate(()=>{ window.__setView('trends'); });
  await page.waitForTimeout(500);

  R.hist = await page.evaluate(()=>{
    const H = historyAt('mid');
    const rows = H.rows;
    const crossMonth = rows.filter(r=>r.first.period !== r.last.period).length;
    const withPrev   = rows.filter(r=>r.prev).length;
    // a concrete MID: compare segmented delta against the naive whole-library one
    const r = rows.find(x=>x.nAll===4 && x.last.cb>0 && x.prev);
    return {
      periods: H.periods, days: H.days,
      nRows: rows.length,
      crossMonthDeltas: crossMonth,
      rowsWithPriorMonth: withPrev,
      sample: r ? {
        id:r.id, period:r.period, prevPeriod:r.prevPeriod,
        n:r.n, nAll:r.nAll,
        segFirstCB:r.first.cb, lastCB:r.last.cb, dcb:r.dcb,
        naiveDcb: r.last.cb - r.allFirst.cb,
        priorMonthFinalCB: r.prev.cb,
        segFirstPeriod:r.first.period, lastPeriod:r.last.period
      } : null
    };
  });

  R.momRendered = await page.evaluate(()=> !!document.getElementById('s-mom'));
  R.momHeader = await page.evaluate(()=>{
    const h=document.getElementById('s-mom'); return h? h.textContent.replace(/\s+/g,' ').trim():null; });

  // per-day toggle
  R.beforeNorm = await page.evaluate(()=>{
    const c=document.querySelector('table.mt tbody tr td:nth-child(4) .v');
    return c? c.textContent.replace(/\s+/g,' ').trim():null; });
  await page.evaluate(()=>{ const b=document.querySelector('[data-norm="1"]'); b && b.click(); });
  await page.waitForTimeout(500);
  R.normOn = await page.evaluate(()=>window.__midTrend? null : null);
  R.afterNorm = await page.evaluate(()=>{
    const c=document.querySelector('table.mt tbody tr td:nth-child(4) .v');
    return c? c.textContent.replace(/\s+/g,' ').trim():null; });
  R.normBtnActive = await page.evaluate(()=> !!document.querySelector('[data-norm="1"].on'));

  // back to audit view, confirm the headline numbers are untouched
  await page.evaluate(()=>{ const b=document.querySelector('[data-norm="0"]'); b && b.click(); });
  await page.evaluate(()=>window.__setView('audit'));
  await page.waitForTimeout(600);
  R.headline = await page.evaluate(()=>{
    const h=document.querySelector('.headline'); return h?h.textContent.replace(/\s+/g,' ').trim():null; });
  R.thinCount = await page.evaluate(()=>{
    const rows = unpackRows(LIB.find(s=>s.id===ACTIVE).rows).map(score);
    return {thin: rows.filter(r=>r.thin).length, total: rows.length,
            thinFlagged: rows.filter(r=>r.thin&&r.nf>0).length};
  });
  R.thinBadgesInDom = await page.evaluate(()=>document.querySelectorAll('.thinb').length);
  R.headlineHasMTD  = /month-to-date/i.test(R.headline||'');
  R.footerPeriod    = await page.evaluate(()=>
    /reset to zero on the 1st/i.test(document.getElementById('foot').textContent||''));
  await page.evaluate(()=>window.__setView('settings'));
  await page.waitForTimeout(400);
  R.settingsKnob = await page.evaluate(()=>{
    const i=document.querySelector('input[data-m="thinSales"]');
    return i? {value:i.value, visible:true} : null; });
  R.settingsErrors = errs.slice();
  R.finalErrors = errs;
  console.log(JSON.stringify(R,null,2));
  await b.close();
})();
