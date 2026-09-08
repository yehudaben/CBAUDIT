/* ============================================================
   CBAUDIT — chargeback DETAIL bookmarklet
   Run this ON the portal (portal.paymenthelp.ai), where it is same-origin and
   rides your existing login. It pulls the per-case chargeback detail for a set
   of MIDs and hands back ONE combined CSV the console ingests (Paste report, or
   drop the downloaded file in the folder).

   Why this exists: the portal has no bulk detail export. Detail lives one MID
   at a time at /search/?mid=<MID>. This loops that endpoint and stitches the
   rows together, adding a MID column so the console can join by merchant.

   Flow:
     1. In the console, click "Copy flagged MIDs".
     2. On the portal report page, click this bookmark.
     3. Paste the MIDs when prompted (or leave blank to use every MID in the
        report grid). It fetches each, builds the CSV, and shows Copy / Download.
     4. Back in the console: Paste report (or drop the file in the folder).

   Nothing is uploaded anywhere. It reads pages you can already open and writes
   only to your clipboard / downloads.
   ============================================================ */
(function(){
  "use strict";
  var ORIGIN = location.origin;
  if(!/paymenthelp\.ai$/i.test(location.hostname)){
    alert("Run this on the Paymenthelp portal (portal.paymenthelp.ai), not here.");
    return;
  }

  /* ---- 1. the MID list ---- */
  function fromGrid(){
    /* MIDs sit in the report grid; the grid may be inside the "main" frame */
    var docs = [document];
    try{ if(window.frames && window.frames.main && window.frames.main.document)
           docs.push(window.frames.main.document); }catch(e){}
    var found = {};
    docs.forEach(function(d){
      /* a MID is a 15–16 digit string; pick cells that are exactly that */
      [].forEach.call(d.querySelectorAll("td,span,div,a"), function(el){
        var t = (el.textContent||"").trim();
        if(/^\d{15,16}$/.test(t)) found[t] = 1;
      });
    });
    return Object.keys(found);
  }
  var pasted = prompt(
    "Paste the flagged MIDs (from the console's “Copy flagged MIDs”).\n"+
    "Separated by spaces, commas or new lines.\n\n"+
    "Leave blank to pull every MID in the current report grid.");
  if(pasted===null) return;                       /* cancelled */
  var mids = pasted.trim()
    ? pasted.split(/[^\d]+/).filter(function(x){ return x.length>=10; })
    : fromGrid();
  /* de-dupe, keep order */
  mids = mids.filter(function(m,i){ return mids.indexOf(m)===i; });
  if(!mids.length){ alert("No MIDs found. Copy them from the console first, or open the report grid."); return; }

  /* ---- 2. an overlay so the pull is visible and cancellable ---- */
  var stop = false;
  var box = document.createElement("div");
  box.style.cssText = "position:fixed;z-index:2147483647;right:16px;bottom:16px;width:360px;"+
    "font:13px/1.5 system-ui,sans-serif;background:#111;color:#eee;border:1px solid #333;"+
    "border-radius:10px;padding:14px 16px;box-shadow:0 8px 30px rgba(0,0,0,.4)";
  box.innerHTML = "<b>Chargeback detail pull</b><div id='cbd_s' style='margin:6px 0'>starting…</div>"+
    "<div style='height:6px;background:#333;border-radius:3px;overflow:hidden'>"+
    "<div id='cbd_b' style='height:100%;width:0;background:#3987e5'></div></div>"+
    "<div id='cbd_a' style='margin-top:10px;display:flex;gap:8px;flex-wrap:wrap'></div>";
  document.body.appendChild(box);
  var S = box.querySelector("#cbd_s"), B = box.querySelector("#cbd_b"), A = box.querySelector("#cbd_a");
  function say(t){ S.textContent = t; }
  function btn(label, fn){
    var b=document.createElement("button"); b.textContent=label;
    b.style.cssText="background:#3987e5;color:#fff;border:0;border-radius:6px;padding:6px 10px;cursor:pointer;font:inherit";
    b.onclick=fn; A.appendChild(b); return b;
  }
  var cancel = btn("Cancel", function(){ stop=true; say("cancelled."); });

  /* ---- 3. parse one /search page into rows ---- */
  var OUT_COLS = ["Card #","Prim. / Sec.","Case #","Type","Scheme","Brand","Bank",
    "Country","ARN","Report Date","Trans. Date","Case Amount","Merchant Amount",
    "Reason","Status","Auth Code","Origin Ref #"];   /* the 17 detail columns, in page order */
  function parseDetailPage(htmlText){
    var doc = new DOMParser().parseFromString(htmlText, "text/html");
    /* the detail table is the one whose header carries "ARN" */
    var table = null;
    [].forEach.call(doc.querySelectorAll("table"), function(t){
      if(table) return;
      var ths = [].map.call(t.querySelectorAll("th"), function(h){ return (h.textContent||"").trim().toLowerCase(); });
      if(ths.indexOf("arn")>=0 && ths.indexOf("case #")>=0) table = t;
    });
    if(!table) return [];
    var n = OUT_COLS.length;
    var rows = [];
    [].forEach.call(table.querySelectorAll("tr"), function(tr){
      var tds = tr.querySelectorAll("td");
      if(tds.length !== n) return;                 /* skips the MID/Merchant info row */
      var cells = [].map.call(tds, function(td){ return (td.textContent||"").trim(); });
      /* a real data row has a numeric Case # (index 2) */
      if(!/^\d{6,}$/.test(cells[2])) return;
      rows.push(cells);
    });
    return rows;
  }

  /* ---- 4. loop the MIDs ---- */
  function csvField(v){
    v = String(v==null?"":v);
    return /[",\n]/.test(v) ? '"'+v.replace(/"/g,'""')+'"' : v;
  }
  var header = ["MID"].concat(OUT_COLS).map(csvField).join(",");
  var lines = [header], nCases = 0, nWith = 0, done = 0;

  function pull(i){
    if(stop || i>=mids.length){ return finish(); }
    var mid = mids[i];
    say("MID "+(i+1)+" of "+mids.length+" — "+mid+"  ("+nCases+" cases so far)");
    B.style.width = Math.round((i/mids.length)*100)+"%";
    fetch(ORIGIN+"/search/?mid="+encodeURIComponent(mid), {credentials:"include"})
      .then(function(r){ return r.text(); })
      .then(function(t){
        var rows = parseDetailPage(t);
        if(rows.length) nWith++;
        rows.forEach(function(c){ lines.push([mid].concat(c).map(csvField).join(",")); nCases++; });
      })
      .catch(function(){ /* one MID failing must not kill the run */ })
      .then(function(){ done++; setTimeout(function(){ pull(i+1); }, 120); });
  }

  function finish(){
    B.style.width = "100%";
    say((stop?"stopped":"done")+" — "+nCases+" cases from "+nWith+" of "+mids.length+" MIDs.");
    var csv = lines.join("\n");
    A.innerHTML = "";
    btn("Copy CSV", function(){
      (navigator.clipboard && navigator.clipboard.writeText
        ? navigator.clipboard.writeText(csv)
        : Promise.reject()).then(function(){ say("copied — paste into the console (Paste report)."); },
        function(){ showTextarea(csv); });
    });
    btn("Download details.csv", function(){
      var a=document.createElement("a");
      a.href=URL.createObjectURL(new Blob([csv],{type:"text/csv"}));
      a.download="details.csv"; a.click();
      say("downloaded details.csv — drop it in your console folder, or use the file picker.");
    });
    btn("Close", function(){ box.remove(); });
  }
  function showTextarea(csv){
    var ta=document.createElement("textarea");
    ta.value=csv; ta.style.cssText="width:100%;height:120px;margin-top:8px;font:11px monospace";
    box.appendChild(ta); ta.select();
    say("Clipboard blocked — select all in the box and copy manually.");
  }

  pull(0);
})();
