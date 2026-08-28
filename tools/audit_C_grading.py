# -*- coding: utf-8 -*-
"""AUDIT C — grading. Re-derive flags, bonus, weight, tier and primary for
all 806 rows from the written spec, independently of the app's code."""
# Paths come from the environment so this runs anywhere. SAMPLE_CSV is the
# portal export to audit against; it is kept out of git (see fixtures/).
import os as _os
_ROOT   = _os.path.dirname(_os.path.dirname(_os.path.abspath(__file__)))
SAMPLE  = _os.environ.get("SAMPLE_CSV", _os.path.join(_ROOT, "fixtures", "sample.csv"))
DUMP    = _os.environ.get("APP_DUMP",   _os.path.join(_ROOT, "fixtures", "app_dump.json"))
import csv, json, re
from decimal import Decimal, getcontext
getcontext().prec = 40

app = json.load(open(DUMP))
M = app["model"]; arows = {r["id"]: r for r in app["rows"]}
rows = list(csv.reader(open(SAMPLE, encoding='utf-8-sig')))
hdr=[h.strip() for h in rows[0]]; COL={h:i for i,h in enumerate(hdr) if h}
body=[r for r in rows[1:] if len(r)>=18 and r[3].strip()]
def dec(s):
    c=re.sub(r'[$%\s]','',(s or '')).replace(',','')
    if c in ('','-'): return Decimal(0)
    try: return Decimal(c)
    except Exception: return Decimal(0)

W  = M["w"]
D  = lambda k: Decimal(str(M[k]))
SEV = ["F5","F1","F3","F4","F2"]

print("="*72); print("AUDIT C — GRADING"); print("="*72)
print("model in force:", json.dumps(M, separators=(",",":")))

def grade(r):
    """Implemented straight from the written rules, not from the app."""
    s,ds,dr = dec(r[COL['# Sales']]), dec(r[COL['$ Sales']]), dec(r[COL['$ Rfnds']])
    cb,rn   = dec(r[COL['CB #']]), dec(r[COL['# RDR']])
    ax,vi   = dec(r[COL['Amex']]), dec(r[COL['Visa']])
    mc,dc   = dec(r[COL['MC']]), dec(r[COL['Disc']])
    cbp = (cb/s*100) if s>0 else None
    rfp = (dr/ds*100) if ds>0 else None
    cov = (rn/(rn+vi)*100) if (rn+vi)>0 else None
    F=[]
    # F1: Visa >= threshold AND (RDR = 0 OR coverage < threshold)
    if vi >= D('f1Visa') and (rn == 0 or (cov is not None and cov < D('f1Cov'))): F.append("F1")
    # F2: RDR = 0 AND Visa > threshold
    if rn == 0 and vi > D('f2Visa'): F.append("F2")
    # F3: MC > threshold AND Refund % < threshold
    if mc > D('f3Mc') and rfp is not None and rfp < D('f3Rfnd'): F.append("F3")
    # F4: Amex >= threshold OR Disc >= threshold
    if ax >= D('f4Brand') or dc >= D('f4Brand'): F.append("F4")
    # F5: CB % > threshold AND CB # >= threshold
    if cbp is not None and cbp > D('f5Cbp') and cb >= D('f5Cb'): F.append("F5")
    zs  = (s == 0 and cb > 0)
    bad = (cbp is not None and cbp > 100)
    base = sum(W[f] for f in F)
    bon = 0
    if "F5" in F and not bad:
        bon = M['bonHiPts'] if cbp > D('bonHi') else (M['bonMidPts'] if cbp >= D('bonMid') else 0)
    w = base if bad else base + bon
    pri = next((x for x in SEV if x in F), "")
    if bad: tier="QUARANTINE"
    elif zs: tier="INTEGRITY"
    elif not F: tier="NONE"
    elif w >= M['tierCrit']: tier="CRITICAL"
    elif w >= M['tierHigh']: tier="HIGH"
    else: tier="MONITOR"
    return dict(F="+".join(F), nf=len(F), bon=bon, w=w, pri=pri, zs=zs, bad=bad, tier=tier)

bad=[]; counts={}
for r in body:
    mid=r[COL['MID']].strip(); a=arows[mid]; g=grade(r)
    for k in ("F","nf","bon","w","pri","zs","bad","tier"):
        if a[k] != g[k]:
            bad.append(f"{mid} {k}: spec={g[k]!r} app={a[k]!r}")
    counts[g["tier"]] = counts.get(g["tier"],0)+1

print(f"\nrows graded from the spec    : {len(body)}")
print(f"grading mismatches           : {len(bad)}   (flags, bonus, weight, primary, tier)")
for x in bad[:10]: print("   !!", x)

print("\ntier counts, spec vs app:")
appt = app["totals"]
pairs = [("CRITICAL",appt["crit"]),("HIGH",appt["high"]),("MONITOR",appt["mon"]),
         ("QUARANTINE",appt["quar"]),("INTEGRITY",appt["integ"]),
         ("NONE",appt["total"]-appt["crit"]-appt["high"]-appt["mon"]-appt["quar"]-appt["integ"])]
for name, appv in pairs:
    specv = counts.get(name,0)
    print(f"  {name:<11} spec {specv:>4}   app {appv:>4}   {'ok' if specv==appv else 'MISMATCH'}")
tot = sum(counts.values())
print(f"  {'TOTAL':<11} spec {tot:>4}   app {appt['total']:>4}   "
      f"{'reconciles' if tot==appt['total'] else 'MISMATCH'}")

print("\nflag counts, spec vs app:")
for f in ["F1","F2","F3","F4","F5"]:
    spec = sum(1 for r in body if f in grade(r)["F"].split("+"))
    print(f"  {f}  spec {spec:>3}   app {appt['flagCounts'][f]:>3}   "
          f"{'ok' if spec==appt['flagCounts'][f] else 'MISMATCH'}")

# --- severity order of the Primary column ------------------------------
print("\nprimary-flag severity order (F5 > F1 > F3 > F4 > F2):")
viol=[]
for r in body:
    g=grade(r)
    if not g["F"]: continue
    fl=g["F"].split("+")
    expected=next(x for x in SEV if x in fl)
    if g["pri"]!=expected: viol.append(r[COL['MID']].strip())
print(f"  rows with 2+ flags        : {sum(1 for r in body if grade(r)['nf']>=2)}")
print(f"  severity violations       : {len(viol)}")

# --- exclusion rules ---------------------------------------------------
zs_ranked  = [r for r in body if grade(r)['zs'] and grade(r)['tier'] in ('CRITICAL','HIGH','MONITOR')]
bad_bonus  = [r for r in body if grade(r)['bad'] and grade(r)['bon']!=0]
print("\nexclusion rules:")
print(f"  zero-sale rows given a rank : {len(zs_ranked)}  (must be 0)")
print(f"  CB%>100 rows given a bonus  : {len(bad_bonus)}  (must be 0)")

# --- bonus band distribution ------------------------------------------
from collections import Counter
bands = Counter()
for r in body:
    g=grade(r)
    if "F5" in g["F"].split("+"): bands[g["bon"]] += 1
print(f"\nbonus bands on F5 rows      : {dict(sorted(bands.items()))}"
      f"   (expect keys 0/{M['bonMidPts']}/{M['bonHiPts']})")
