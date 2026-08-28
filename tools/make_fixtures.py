#!/usr/bin/env python3
"""Build multi-month fixtures from one real portal export.

The monthly-reset logic cannot be tested with a single report, and it is the
part most likely to break silently. This scales one export into a series that
straddles a month boundary, keeping the portal's own % columns internally
consistent so the app's cross-check still passes.

    python3 tools/make_fixtures.py fixtures/sample.csv

Writes fx_2026-07-24, fx_2026-07-31 (prior-month final), fx_2026-08-05 and
copies the source to fx_2026-08-14. Nothing here is real data beyond the
export you point it at, and fixtures/ is gitignored.
"""
import csv, os, random, sys, shutil

random.seed(7)   # deterministic: the same input always yields the same fixtures

COUNT = ['# Sales', 'CB #', '# RDR', 'Amex', 'Visa', 'MC', 'Disc']
MONEY = ['$ Sales', '$ Rfnds', 'CB Vol.', '$ RDR']
PLAN  = [('fx_2026-07-24-0900.csv', 1.70),
         ('fx_2026-07-31-2300.csv', 2.20),   # July's final report
         ('fx_2026-08-05-0900.csv', 0.33)]   # counters reset on the 1st


def num(x):
    x = (x or '').replace(',', '').replace('$', '').replace('%', '').strip()
    try:    return float(x)
    except: return 0.0


def scale(rows, H, f, jitter=0.05):
    out = []
    for r in rows:
        r = list(r)
        for c in COUNT:
            r[H[c]] = '{:,}'.format(int(round(num(r[H[c]]) * f * random.uniform(1-jitter, 1+jitter))))
        for c in MONEY:
            r[H[c]] = '${:,.2f}'.format(num(r[H[c]]) * f * random.uniform(1-jitter, 1+jitter))
        s, cb = num(r[H['# Sales']]), num(r[H['CB #']])
        ds, dr = num(r[H['$ Sales']]), num(r[H['$ Rfnds']])
        r[H['% CB']]      = '{:,.2f}%'.format(cb/s*100) if s > 0 else ''
        r[H['% Rfnds']]   = '{:,.2f}%'.format(dr/ds*100) if ds > 0 else ''
        r[H['Avg Sales']] = '${:,.2f}'.format(ds/s) if s > 0 else '$0.00'
        out.append(r)
    return out


def main(src):
    out_dir = os.path.dirname(os.path.abspath(src))
    data = list(csv.reader(open(src, encoding='utf-8-sig')))
    head, rows = data[0], data[1:]
    H = {h.strip(): i for i, h in enumerate(head) if h.strip()}
    missing = [c for c in COUNT + MONEY if c not in H]
    if missing:
        sys.exit('source is missing columns: %s' % ', '.join(missing))

    for name, f in PLAN:
        p = os.path.join(out_dir, name)
        w = csv.writer(open(p, 'w', newline=''))
        w.writerow(head); w.writerows(scale(rows, H, f))
        print('wrote', name)
    shutil.copy(src, os.path.join(out_dir, 'fx_2026-08-14-0901.csv'))
    print('wrote fx_2026-08-14-0901.csv (copy of source)')


if __name__ == '__main__':
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    main(sys.argv[1])
