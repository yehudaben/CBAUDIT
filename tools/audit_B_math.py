# -*- coding: utf-8 -*-
"""AUDIT B — arithmetic. Recompute every metric with Decimal (exact) and
compare to the app's float results and to the portal's own % columns."""
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
arows = {r["id"]: r for r in app["rows"]}
rows = list(csv.reader(open(SAMPLE, encoding='utf-8-sig')))
hdr = [h.strip() for h in rows[0]]; COL = {h:i for i,h in enumerate(hdr) if h}
body = [r for r in rows[1:] if len(r)>=18 and r[3].strip()]

def dec(s):
    c = re.sub(r'[$%\s]','',(s or '')).replace(',','')
    if c in ('','-'): return Decimal(0)
    try: return Decimal(c)
    except Exception: return Decimal(0)

print("="*72); print("AUDIT B — ARITHMETIC"); print("="*72)

TOL_APP    = Decimal("0.0000001")   # app float vs exact Decimal
TOL_PORTAL = Decimal("0.006")       # portal rounds to 2dp

bad_app, bad_portal = [], []
n_cbp = n_rfp = n_cov = n_mcs = 0
pc = pr = 0

for r in body:
    mid = r[COL['MID']].strip(); a = arows[mid]
    s, ds, dr = dec(r[COL['# Sales']]), dec(r[COL['$ Sales']]), dec(r[COL['$ Rfnds']])
    cb, rn    = dec(r[COL['CB #']]), dec(r[COL['# RDR']])
    vi, mc    = dec(r[COL['Visa']]), dec(r[COL['MC']])

    # exact expected values
    cbp = (cb/s*100) if s>0 else None
    rfp = (dr/ds*100) if ds>0 else None
    cov = (rn/(rn+vi)*100) if (rn+vi)>0 else None
    mcs = (mc/cb*100) if cb>0 else None

    for label, want, got in [("CB %",cbp,a["cbp"]),("Refund %",rfp,a["rfp"]),
                             ("RDR cov",cov,a["cov"]),("MC share",mcs,a["mcs"])]:
        if want is None:
            if got is not None: bad_app.append(f"{mid} {label}: expected null, app={got}")
        else:
            if got is None:
                bad_app.append(f"{mid} {label}: expected {want}, app=null")
            elif abs(Decimal(str(got)) - want) > TOL_APP:
                bad_app.append(f"{mid} {label}: exact={want:.10f} app={got}")
        if want is not None:
            if label=="CB %": n_cbp+=1
            elif label=="Refund %": n_rfp+=1
            elif label=="RDR cov": n_cov+=1
            else: n_mcs+=1

    # cross-check against the portal's own printed percentages
    pcb, prf = r[COL['% CB']].strip(), r[COL['% Rfnds']].strip()
    if re.search(r'\d', pcb) and cbp is not None:
        pc += 1
        if abs(dec(pcb) - cbp) > TOL_PORTAL:
            bad_portal.append(f"{mid} CB%: ours={cbp:.4f} portal={pcb}")
    if re.search(r'\d', prf) and rfp is not None:
        pr += 1
        if abs(dec(prf) - rfp) > TOL_PORTAL:
            bad_portal.append(f"{mid} Rfnd%: ours={rfp:.4f} portal={prf}")

print(f"metrics recomputed exactly  : CB% {n_cbp}, Refund% {n_rfp}, RDR cov {n_cov}, MC share {n_mcs}")
print(f"                              total {n_cbp+n_rfp+n_cov+n_mcs:,} values")
print(f"app vs exact Decimal        : {len(bad_app)} mismatches (tolerance 1e-7)")
for x in bad_app[:8]: print("   !!", x)
print(f"\nours vs portal's own columns: {pc+pr:,} comparisons, {len(bad_portal)} disagree")
for x in bad_portal[:8]: print("   !!", x)

# ---- hand-check a spread of rows, printed so they can be eyeballed ----
print("\nhand-check sample (independent long division):")
picks = ["0700100000199485","0567000000973495","0567000000846071",
         "0567000000847822","0567000000929513","0567000000924753"]
for mid in picks:
    r = next(x for x in body if x[COL['MID']].strip()==mid); a=arows[mid]
    s,cb = dec(r[COL['# Sales']]), dec(r[COL['CB #']])
    ds,dr= dec(r[COL['$ Sales']]), dec(r[COL['$ Rfnds']])
    cbp = f"{cb/s*100:.4f}%" if s>0 else "n/a (no sales)"
    rfp = f"{dr/ds*100:.4f}%" if ds>0 else "n/a"
    print(f"  {a['d'][:26]:<26} {cb}/{s} = {cbp:<16} portal {r[COL['% CB']]:<12}"
          f" rfnd {rfp:<12} portal {r[COL['% Rfnds']]}")

# ---- the negative-value rows, examined ----
print("\nrows with negative source values:")
for r in body:
    mid=r[COL['MID']].strip()
    negs=[(c,dec(r[COL[c]])) for c in ['$ Rfnds','CB Vol.','$ Sales','# Sales']
          if dec(r[COL[c]])<0]
    if not negs: continue
    a=arows[mid]
    print(f"  {mid} {a['d'][:22]:<22} {negs}")
    print(f"      sales {a['s']}  $sales {a['ds']}  cb {a['cb']}  "
          f"rfnd% {('%.4f'%a['rfp']) if a['rfp'] is not None else 'n/a'}  "
          f"flags {a['F'] or '—'}  tier {a['tier']}")
