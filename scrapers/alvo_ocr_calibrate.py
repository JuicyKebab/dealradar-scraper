#!/usr/bin/env python3
"""Kalibratie-harness voor alvo_ocr.py.

Voedt de parser met SYNTHETISCHE tokens die de echte Alvo-folderpagina
(publicatie 96075/1994469) nabootsen — zo kalibreren we de parse-logica
(prijzen, dealbadges, naam, categorie) zonder torch/EasyOCR te installeren.

De coördinaten/hoogtes zijn overgenomen uit de echte pagina-lay-out:
4 tegels (Dreft-wasmiddel, Tomaten, Jupiler-pils, Tartelette) plus banner-
en footer-ruis die NIET in een productnaam mag lekken.

Run:  python alvo_ocr_calibrate.py
"""
import json
import alvo_ocr as A


def tok(text, cx, cy, h, w=None):
    w = w if w is not None else max(len(text) * h * 0.55, h)
    return {
        "text": text, "conf": 0.9,
        "x0": cx - w / 2, "x1": cx + w / 2,
        "y0": cy - h / 2, "y1": cy + h / 2,
        "cx": cx, "cy": cy, "h": h,
    }


# --- Tegel A: Dreft wasmiddel (linksboven) ---------------------------------
tiles = [
    tok("WASMIDDEL", 520, 560, 30),
    tok("Dreft assortiment poeder,", 560, 596, 20),
    tok("caps, doekjes,", 540, 620, 20),
    tok("wasverzachter, vloeibaar", 560, 644, 20),
    tok("of quickwash", 540, 668, 20),
    tok("14-58 scoops", 540, 692, 20),
    tok("Bijv. 2 x wasverzachter", 560, 730, 18),
    tok("white blossoms 40 scoops", 560, 752, 18),
    tok("10,38", 520, 792, 22),          # doorgestreepte van-prijs
    tok("5,19", 578, 792, 26),           # nu-prijs
    tok("/2", 612, 795, 18),
    tok("1+1", 590, 852, 70),            # badge
    tok("GRATIS", 600, 900, 44),
]

# --- Tegel B: Tomaten (rechtsboven) + banner-ruis --------------------------
tiles += [
    tok("WEEKAANBIEDING GELDIG", 1010, 470, 20),   # bannerruis -> moet weg
    tok("500 g", 1230, 828, 40),
    tok("+500 g", 1240, 872, 40),
    tok("GRATIS", 1240, 912, 40),
    tok("1,98/kg", 1250, 950, 20),                 # referentie -> geen prijs
    tok("TOMATEN", 1000, 920, 30),
    tok("België", 1000, 948, 22),
]

# --- Tegel C: Jupiler pils (linksonder) + footer-ruis ----------------------
tiles += [
    tok("PILS", 520, 1010, 32),
    tok("Jupiler", 520, 1040, 22),
    tok("bak", 515, 1062, 20),
    tok("24 x 33 cl", 540, 1086, 20),              # volume -> geen prijs
    tok("38,78", 520, 1200, 22),                   # van-prijs
    tok("29,09", 580, 1200, 26),                   # nu-prijs
    tok("/2", 614, 1203, 18),
    tok("2e", 600, 1258, 40),                      # multiline badge
    tok("AAN", 600, 1300, 40),
    tok("-50%", 600, 1346, 46),
    tok("Alcoholmisbruik schaadt de gezondheid", 350, 1520, 18),  # footerruis
]

# --- Tegel D: Tartelette (rechtsonder) -------------------------------------
tiles += [
    tok("TARTELETTE", 1000, 1360, 30),
    tok("APPEL FRANGIPANE", 1010, 1388, 24),
    tok("98 g", 1000, 1412, 20),
    tok("1+1", 1240, 1280, 70),
    tok("GRATIS", 1250, 1326, 44),
    tok("1,89/stuk", 1250, 1362, 20),              # referentie -> geen prijs
]

# --- pipeline (zonder OCR) --------------------------------------------------
A.merge_split_prices(tiles)
groups = A.cluster_tokens(tiles)
raw = [d for d in (A.build_deal(g) for g in groups) if d]
deals = A.normalize(raw)

print(f"# tegels geclusterd: {len(groups)}")
print(f"# deals: {len(deals)}\n")
for d in deals:
    print(f"- {d['item']!r}")
    print(f"    deal={d['deal']!r}  new={d['newPrice']}  orig={d['originalPrice']}  "
          f"savings={d['savings']}%  cat={d['category']}  hot={d['hot']}")

# --- verwachtingen (uit de echte folder) -----------------------------------
print("\n=== checks ===")
by_item = {d["item"].lower(): d for d in deals}


def check(name, cond):
    print(f"  [{'OK ' if cond else 'FAIL'}] {name}")
    return cond


def find(sub):
    for k, d in by_item.items():
        if sub in k:
            return d
    return None

ok = True
dreft = find("wasmiddel") or find("dreft")
ok &= check("Dreft: 1+1 gratis, new 5.19, orig 10.38, savings 50, Huishouden",
            bool(dreft) and dreft["newPrice"] == 5.19 and dreft["originalPrice"] == 10.38
            and dreft["savings"] == 50 and "1+1" in dreft["deal"] and dreft["category"] == "Huishouden")

tom = find("tomaten")
ok &= check("Tomaten: geen euro-prijs (1,98/kg geweerd), deal Gratis, Groenten & Fruit",
            bool(tom) and tom["newPrice"] == 0 and "gratis" in tom["deal"].lower()
            and tom["category"] == "Groenten & Fruit"
            and "weekaanbieding" not in tom["item"].lower())

jup = find("pils") or find("jupiler")
ok &= check("Jupiler: 2e aan -50%, new 29.09, orig 38.78, savings 50, Dranken",
            bool(jup) and jup["newPrice"] == 29.09 and jup["originalPrice"] == 38.78
            and jup["savings"] == 50 and "-50%" in jup["deal"] and jup["category"] == "Dranken"
            and "alcoholmisbruik" not in jup["item"].lower())

tart = find("tartelette")
ok &= check("Tartelette: 1,89/stuk geweerd, deal 1+1 gratis, savings 50, Bakkerij & Snacks",
            bool(tart) and tart["newPrice"] == 0 and "1+1" in tart["deal"]
            and tart["savings"] == 50 and tart["category"] == "Bakkerij & Snacks")

print(f"\n{'ALLE CHECKS GESLAAGD' if ok else 'ER ZIJN FAILURES'}")
raise SystemExit(0 if ok else 1)
