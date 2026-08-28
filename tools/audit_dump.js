const { chromium } = require('playwright');
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
  const p = await b.newPage();
  const errs=[]; p.on('pageerror',e=>errs.push(e.message));
  await p.goto(BASE + '/index.html');
  await p.evaluate(t=>window.__loadForTest(t,'CB______2026081401.01.38.csv'),
    fs.readFileSync(SAMPLE,'utf8'));
  const dump = await p.evaluate(()=>{
    const A=window.__A;
    return {
      model: window.__modelState(),
      totals: {total:A.total, active:A.active, inert:A.inert, withCB:A.withCB,
               ranked:A.ranked.length, crit:A.crit.length, high:A.high.length,
               mon:A.mon.length, quar:A.quar.length, integ:A.integ.length,
               flagCounts:A.flagCounts, nfTiers:A.nfTiers, buckets:A.buckets.length},
      rows: A.E.map(e=>({
        b:e.b,m:e.m,d:e.d,id:e.id,
        s:e.s,ds:e.ds,dr:e.dr,cb:e.cb,cv:e.cv,rn:e.rn,
        ax:e.ax,vi:e.vi,mc:e.mc,dc:e.dc,
        cbp:e.cbp,rfp:e.rfp,cov:e.cov,mcs:e.mcs,
        F:e.F.join('+'), nf:e.nf, bon:e.bon, w:e.w, pri:e.pri,
        zs:e.zs, bad:e.bad, tier:tierOf(e),
        pcbSrc:e.pcbSrc, prfSrc:e.prfSrc
      })),
      bucketAgg: A.buckets.map(x=>({name:x.name,n:x.n,fl:x.fl,zs:x.zs,s:x.s,ds:x.ds,
        dr:x.dr,cb:x.cb,rn:x.rn,ax:x.ax,vi:x.vi,mc:x.mc,dc:x.dc}))
    };
  });
  fs.writeFileSync(path.join(FIX,'app_dump.json'), JSON.stringify(dump));
  console.log('dumped', dump.rows.length, 'rows | page errors:', errs.length||'none');
  await b.close();
})();
