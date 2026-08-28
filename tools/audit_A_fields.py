# -*- coding: utf-8 -*-
"""AUDIT A — field capture. Independent parse of the raw CSV, then a
cell-for-cell comparison against every field the app parsed."""
# Paths come from the environment so this runs anywhere. SAMPLE_CSV is the
# portal export to audit against; it is kept out of git (see fixtures/).
import os as _os
_ROOT   = _os.path.dirname(_os.path.dirname(_os.path.abspath(__file__)))
SAMPLE  = _os.environ.get("SAMPLE_CSV", _os.path.join(_ROOT, "fixtures", "sample.csv"))
DUMP    = _os.environ.get("APP_DUMP",   _os.path.join(_ROOT, "fixtures", "app_dump.json"))
import csv, json, re, sys
from decimal import Decimal

RAW = SAMPLE
app = json.load(open(DUMP))
arows = {r["id"]: r for r in app["rows"]}

# --- independent parser: Python's csv module, Decimal arithmetic ---------
def dec(s):
    """Strip currency/percent formatting; keep sign. Decimal, not float."""
    c = re.sub(r'[$%\s]', '', (s or '')).replace(',', '')
    if c in ('', '-'): return Decimal(0)
    try: return Decimal(c)
    except Exception: return Decimal(0)

rows = list(csv.reader(open(RAW, encoding='utf-8-sig')))
hdr = [h.strip() for h in rows[0]]
COL = {h: i for i, h in enumerate(hdr) if h}
body = [r for r in rows[1:] if len(r) >= 18 and r[3].strip()]

print("=" * 72)
print("AUDIT A — FIELD CAPTURE")
print("=" * 72)
print(f"header columns in file      : {len([h for h in hdr if h])}")
print(f"  {', '.join(h for h in hdr if h)}")
print(f"data rows in file           : {len(body)}")
print(f"rows parsed by the app      : {len(app['rows'])}")
print(f"row count matches           : {len(body)==len(app['rows'])}")

# duplicate MID check
ids = [r[COL['MID']].strip() for r in body]
dupes = {i for i in ids if ids.count(i) > 1}
print(f"duplicate MIDs in file      : {len(dupes)}  {sorted(dupes)[:4] if dupes else ''}")

# which columns does the app actually consume?
CONSUMED = {'Bckt':'b','Merch.':'m','DBA':'d','MID':'id','# Sales':'s','$ Sales':'ds',
            '$ Rfnds':'dr','CB #':'cb','CB Vol.':'cv','# RDR':'rn','Amex':'ax',
            'Visa':'vi','MC':'mc','Disc':'dc','% CB':'pcbSrc','% Rfnds':'prfSrc'}
unused = [h for h in hdr if h and h not in CONSUMED]
print(f"columns consumed            : {len(CONSUMED)} of {len([h for h in hdr if h])}")
print(f"columns NOT consumed        : {unused if unused else 'none'}")

# --- cell-for-cell comparison ------------------------------------------
NUMF = [('# Sales','s'),('$ Sales','ds'),('$ Rfnds','dr'),('CB #','cb'),
        ('CB Vol.','cv'),('# RDR','rn'),('Amex','ax'),('Visa','vi'),('MC','mc'),('Disc','dc')]
TXTF = [('Bckt','b'),('Merch.','m'),('DBA','d'),('MID','id')]

bad = []
checked = 0
for r in body:
    mid = r[COL['MID']].strip()
    a = arows.get(mid)
    if a is None:
        bad.append(f"{mid}: missing from app"); continue
    for col, key in TXTF:
        want = r[COL[col]].strip()
        if str(a[key]) != want:
            bad.append(f"{mid} {col}: file={want!r} app={a[key]!r}")
        checked += 1
    for col, key in NUMF:
        want = dec(r[COL[col]])
        got  = Decimal(str(a[key]))
        if want != got:
            bad.append(f"{mid} {col}: file={want} app={got}")
        checked += 1

print(f"\nfields compared             : {checked:,}  ({len(NUMF)+len(TXTF)} per row x {len(body)} rows)")
print(f"field mismatches            : {len(bad)}")
for x in bad[:10]: print("   !!", x)

# --- edge-case inventory in the source data ----------------------------
def n(col, r): return dec(r[COL[col]])
neg   = [(r[COL['MID']].strip(), col) for r in body for col in
         ['# Sales','$ Sales','$ Rfnds','CB #','CB Vol.','# RDR','Amex','Visa','MC','Disc']
         if n(col, r) < 0]
blank = sum(1 for r in body for col in ['$ Sales','$ Rfnds','CB Vol.']
            if re.sub(r'[$%\s,]','',(r[COL[col]] or ''))=='')
zsales = [r for r in body if n('# Sales', r) == 0]
zs_cb  = [r for r in zsales if n('CB #', r) > 0]
print(f"\nnegative values in source   : {len(neg)}  {neg[:5] if neg else ''}")
print(f"blank money cells           : {blank}")
print(f"rows with # Sales = 0       : {len(zsales)}   of which CB > 0: {len(zs_cb)}")
print(f"largest # Sales             : {max(n('# Sales',r) for r in body):,}")
print(f"largest $ Sales             : ${max(n('$ Sales',r) for r in body):,}")
