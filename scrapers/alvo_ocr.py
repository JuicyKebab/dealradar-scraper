#!/usr/bin/env python3
"""Alvo folder-OCR parser — EasyOCR-alternatief voor Claude Haiku vision.

Doel: geen Anthropic-credits meer nodig voor de Alvo-scraper. EasyOCR levert
ruwe tekst + bounding boxes; deze module reconstrueert daaruit gestructureerde
deals in EXACT hetzelfde schema als railway/scrapers/alvo.js.

Pijplijn:
  1. JS (alvo.js) ontdekt de Publitas spread-images via Playwright.
  2. JS pipet een JSON-array van image-URLs naar de stdin van dit script.
  3. Dit script OCR't elke pagina, clustert tokens tot producttegels, en
     leest per tegel productnaam / prijzen / dealtekst / categorie.
  4. Deals gaan als JSON-array naar stdout; JS schrijft ze naar Supabase.

Gebruik (standalone testen op lokale bestanden — geen Playwright nodig):
    python alvo_ocr.py page1.jpg page2.jpg
Gebruik (productie, URLs via stdin):
    echo '["https://.../page1.jpg", "..."]' | python alvo_ocr.py

Vereisten:  pip install easyocr numpy  (easyocr trekt torch mee, ~1-2 GB)

LET OP — dit is een HEURISTISCHE parser. Anders dan een vision-LLM "begrijpt"
EasyOCR de lay-out niet; hij leest enkel karakters. De kwaliteit hangt volledig
af van de folder-lay-out. De knoppen bovenaan (TUNING) zijn bedoeld om tegen
echte OCR-output bij te stellen. Verifieer altijd tegen een paar echte pagina's.
"""

import io
import json
import re
import sys
import urllib.request

# --- afhankelijkheden die pas bij echt gebruik nodig zijn -------------------
try:
    import numpy as np
except ImportError:  # pragma: no cover
    np = None

# ============================================================================
# TUNING — bijstellen tegen echte OCR-output
# Gekalibreerd tegen de echte Alvo-folder (publicatie 96075/1994469, aug 2026):
# 4 tegels per pagina, inline komma-prijzen "5,19", struck van-prijs + nu-prijs
# samen "10,38 5,19 /2", referentie "1,98/kg", multiline badge "2e AAN -50%".
# ============================================================================
CLUSTER_GAP_FACTOR = 1.3   # tegels mergen als rand-tot-rand-gap < factor * mediaanhoogte
MIN_CONF           = 0.30  # OCR-tokens onder deze confidence negeren
ORIG_MAX_RATIO     = 4.0   # originalPrice > newPrice*ratio => waarschijnlijk /kg- of bundelmisread
ORIG_MIN_RATIO     = 1.03  # originalPrice moet minstens dit boven newPrice liggen om echt te zijn
NAME_HEIGHT_FACTOR = 0.62  # naamtokens moeten >= factor * grootste-naamletterhoogte zijn (dropt fijne omschrijving)
NAME_MAX_WORDS     = 7     # productnaam afkappen zodat de fijne omschrijving niet meelift
# banner-/footer-tekst die nooit in een productnaam hoort (all-lower vergeleken)
NAME_STOPWORDS = {
    "weekaanbieding", "aanbieding", "aanbiedingen", "geldig", "super", "voordelen",
    "gratis", "alvo", "klantenkaart", "klanten", "kaart", "bijv", "van", "tem",
    "alcoholmisbruik", "schaadt", "gezondheid", "folder", "week",
}
# Alvo toont prijzen inline met komma ("5,19"), NIET gesplitst in groot-euro + kleine-centen.
# Daarom staat de split-merge standaard UIT: lone 2-cijfer-tokens als "40 scoops" zouden
# anders valse prijzen vormen. Zet op True voor folders die wel gesplitst renderen.
SPLIT_PRICES       = False
CENTS_DX_FACTOR    = 2.5   # (enkel bij SPLIT_PRICES) centen tot factor*hoogte rechts van euro's
CENTS_DY_FACTOR    = 1.2   # (enkel bij SPLIT_PRICES) ... en tot factor*hoogte verticaal ervan af
STORE_META = {"store": "Alvo", "storeColor": "#006838", "storeLogo": "A"}

# ============================================================================
# Regexen voor tokenclassificatie
# ============================================================================
# prijs ergens in een token: "2,99" / "€2.99" / "5,19 /2" / "1,98/kg"
# (EasyOCR zet soms spaties rond de komma). Niet-geankerd: suffixen als "/2"
# of "/kg" mogen erachter staan; PERUNIT_RE bepaalt daarna of we hem verwerpen.
PRICE_RE       = re.compile(r"€?\s*(\d{1,3})\s*[.,]\s*(\d{2})(?!\d)")
# "2.-" / "2,-" / "2.—"  (heel euro-prijs met streepje als centen)
PRICE_DASH_RE  = re.compile(r"^\s*€?\s*(\d{1,3})\s*[.,]\s*[-—–]\s*€?\s*$")
# los heel getal (mogelijke euro's van een gesplitste prijs "2" + "99")
INT_RE         = re.compile(r"^\s*€?\s*(\d{1,3})\s*€?\s*$")
# losse twee cijfers (mogelijke centen)
CENTS_RE       = re.compile(r"^\s*(\d{2})\s*$")
# gewicht/volume — NOOIT als prijs gebruiken
WEIGHT_RE      = re.compile(r"\b\d+([.,]\d+)?\s*(gr?|kg|ml|cl|l|liter|stuks?|st|x)\b", re.I)
# referentieprijs per eenheid ("1,98/kg", "1,89/stuk") — verwerpen als prijs.
# "/2", "/3" (promoprijs per N stuks) valt hier bewust NIET onder en blijft geldig.
PERUNIT_RE     = re.compile(r"/\s*(kg|l\b|liter|stuks?|st\b|gr?\b|ml|cl)", re.I)

# dealteksten
DEAL_PATTERNS = [
    (re.compile(r"\b1\s*\+\s*1\s*gratis\b", re.I),        "1+1 gratis"),
    (re.compile(r"\b2\s*\+\s*1\s*gratis\b", re.I),        "2+1 gratis"),
    (re.compile(r"\b3\s*\+\s*1\s*gratis\b", re.I),        "3+1 gratis"),
    (re.compile(r"\b2e?\s*(?:aan\s*)?-?\s*(\d{1,2})\s*%", re.I), "2e aan -{0}%"),
    (re.compile(r"-\s*(\d{1,2})\s*%"),                    "-{0}%"),
    (re.compile(r"\bgratis\b", re.I),                     "Gratis"),
    (re.compile(r"\bpromo", re.I),                        "Promoprijs"),
]

# ============================================================================
# Categorisatie op productnaam (EasyOCR geeft geen categorie)
# ============================================================================
CATEGORY_KEYWORDS = [
    ("Bakkerij & Snacks", ["brood", "koek", "cake", "taart", "tartelette", "frangipane", "gebak", "chips", "snack", "wafel", "croissant", "pistolet", "grissini"]),
    ("Dranken",           ["cola", "limonade", "water", "sap", "jus", "bier", "pils", "jupiler", "wijn", "frisdrank", "koffie", "thee", "drank", "energy"]),
    ("Zuivel",            ["yoghurt", "kaas", "boter", "room", "melk", "pudding", "dessert", "ei", "eieren"]),
    ("Vlees & Vis",       ["kip", "vlees", "worst", "ham", "gehakt", "vis", "zalm", "filet", "spek", "salami", "steak", "burger"]),
    ("Diepvries",         ["diepvries", "ijs", "pizza", "frit", "friet", "vriezer"]),
    ("Groenten & Fruit",  ["appel", "banaan", "tomaat", "sla", "groent", "fruit", "aardappel", "ui", "wortel", "peer", "druif", "salade"]),
    ("Verzorging",        ["shampoo", "zeep", "tandpasta", "deo", "douche", "creme", "crème", "luier", "maandverband", "scheermes"]),
    ("Huishouden",        ["wasmiddel", "wasverzachter", "vaatwas", "afwas", "wc", "keukenrol", "toiletpapier", "schoonmaak", "vuilzak", "reiniger"]),
    ("Droogwaren",        ["pasta", "rijst", "saus", "soep", "conserven", "bloem", "suiker", "olie", "azijn", "meel", "chocolade", "snoep", "confituur"]),
]


def categorize(name):
    low = name.lower()
    for cat, words in CATEGORY_KEYWORDS:
        if any(w in low for w in words):
            return cat
    return "Overig"


# ============================================================================
# OCR
# ============================================================================
_reader = None


def get_reader():
    """EasyOCR-reader lui initialiseren (modeldownload gebeurt bij eerste run)."""
    global _reader
    if _reader is None:
        import easyocr  # lokale import: zwaar (torch), pas laden wanneer echt nodig
        _reader = easyocr.Reader(["nl", "fr"], gpu=False)
    return _reader


def load_image(src):
    """Laad een afbeelding (URL of lokaal pad) als numpy-array voor EasyOCR."""
    if src.startswith("http://") or src.startswith("https://"):
        req = urllib.request.Request(src, headers={"User-Agent": "Mozilla/5.0"})
        with urllib.request.urlopen(req, timeout=25) as resp:
            data = resp.read()
    else:
        with open(src, "rb") as fh:
            data = fh.read()
    from PIL import Image  # meegeleverd via easyocr's deps
    img = Image.open(io.BytesIO(data)).convert("RGB")
    return np.array(img)


def ocr_tokens(image):
    """EasyOCR-output normaliseren naar platte token-dicts met geometrie."""
    results = get_reader().readtext(image)  # -> [(bbox, text, conf), ...]
    tokens = []
    for bbox, text, conf in results:
        if conf < MIN_CONF or not text.strip():
            continue
        xs = [p[0] for p in bbox]
        ys = [p[1] for p in bbox]
        x0, x1 = min(xs), max(xs)
        y0, y1 = min(ys), max(ys)
        tokens.append({
            "text": text.strip(),
            "conf": float(conf),
            "x0": x0, "y0": y0, "x1": x1, "y1": y1,
            "cx": (x0 + x1) / 2, "cy": (y0 + y1) / 2,
            "h": max(1.0, y1 - y0),
        })
    return tokens


# ============================================================================
# Prijs-helpers
# ============================================================================
def parse_price(text):
    """Geef (euro_float, is_perunit) terug, of (None, _) als het geen prijs is.

    - "5,19" / "€5.19" / "5,19 /2"  -> (5.19, False)   geldige (promo)prijs
    - "1,98/kg" / "1,89/stuk"       -> (1.98, True)     referentie: verwerpen
    - "500 g" / "24 x 33 cl"        -> (None, False)    gewicht/volume, geen prijs
    """
    per_unit = bool(PERUNIT_RE.search(text))
    m = PRICE_RE.search(text)
    if m:
        # gewicht mag alleen blokkeren als het NIET zelf de gevonden prijs is
        # (bv. "24 x 33 cl" heeft geen komma-prijs; "5,19 /2" wel)
        return float(f"{int(m.group(1))}.{m.group(2)}"), per_unit
    m = PRICE_DASH_RE.match(text)
    if m:
        return float(m.group(1)), per_unit
    if WEIGHT_RE.search(text):
        return None, False
    return None, per_unit


def merge_split_prices(tokens):
    """Belgische folders tonen prijzen vaak als groot euro-getal + kleine centen.

    EasyOCR leest die als losse tokens ("2" en "99"). Hier voegen we een los
    heel getal samen met een klein 2-cijferig token dat er rechtsboven bij staat.
    Voegt een 'price'-veld toe aan de euro-token en markeert de centen-token als
    verbruikt (consumed=True) zodat clustering ze niet als losse namen ziet.

    Standaard UIT voor Alvo (inline komma-prijzen). Zie SPLIT_PRICES.
    """
    if not SPLIT_PRICES:
        return
    ints  = [t for t in tokens if INT_RE.match(t["text"]) and not WEIGHT_RE.search(t["text"])]
    cents = [t for t in tokens if CENTS_RE.match(t["text"])]
    for it in ints:
        best, best_d = None, None
        for c in cents:
            if c.get("consumed"):
                continue
            dx = c["cx"] - it["x1"]           # centen staan rechts van de euro's
            dy = abs(c["cy"] - it["cy"])
            if -it["h"] < dx < CENTS_DX_FACTOR * it["h"] and dy < CENTS_DY_FACTOR * it["h"]:
                d = dx * dx + dy * dy
                if best is None or d < best_d:
                    best, best_d = c, d
        if best is not None:
            euros = int(INT_RE.match(it["text"]).group(1))
            it["price"] = float(f"{euros}.{best['text']}")
            best["consumed"] = True


# ============================================================================
# Clustering: tokens -> producttegels
# ============================================================================
def _boxes_gap(a, b):
    """Kleinste rand-tot-rand-afstand tussen twee bounding boxes (0 bij overlap)."""
    dx = max(0.0, max(a["x0"] - b["x1"], b["x0"] - a["x1"]))
    dy = max(0.0, max(a["y0"] - b["y1"], b["y0"] - a["y1"]))
    return (dx * dx + dy * dy) ** 0.5


def cluster_tokens(tokens):
    """Union-find op ruimtelijke nabijheid — nabije tokens vormen één tegel."""
    live = [t for t in tokens if not t.get("consumed")]
    if not live:
        return []
    median_h = sorted(t["h"] for t in live)[len(live) // 2]
    thresh = CLUSTER_GAP_FACTOR * median_h

    parent = list(range(len(live)))

    def find(i):
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i

    def union(i, j):
        parent[find(i)] = find(j)

    for i in range(len(live)):
        for j in range(i + 1, len(live)):
            if _boxes_gap(live[i], live[j]) < thresh:
                union(i, j)

    groups = {}
    for idx, t in enumerate(live):
        groups.setdefault(find(idx), []).append(t)
    return list(groups.values())


# ============================================================================
# Tegel -> deal
# ============================================================================
def detect_deal(group):
    """Herken de dealtekst (en geef ook een expliciet % terug indien aanwezig).

    Tokens worden eerst ruimtelijk gesorteerd (boven->onder, links->rechts) zodat
    een multiline badge als "2e / AAN / -50%" in de juiste volgorde samenkomt.
    """
    ordered = sorted(group, key=lambda t: (round(t["cy"] / max(1, t["h"])), t["cx"]))
    joined = " ".join(t["text"] for t in ordered)
    for pat, tmpl in DEAL_PATTERNS:
        m = pat.search(joined)
        if m:
            if "{0}" in tmpl and m.groups():
                return tmpl.format(m.group(1)), int(m.group(1))
            return tmpl, None
    return None, None


def build_deal(group):
    """Reconstrueer één deal uit een tegel; None als er te weinig signaal is."""
    # prijzen verzamelen; per-eenheid-referenties (1,98/kg, 1,89/stuk) weren,
    # maar promoprijzen per N stuks ("5,19 /2") behouden.
    prices = []
    for t in group:
        if "price" in t:  # samengevoegde split-prijs (enkel bij SPLIT_PRICES)
            prices.append(t["price"])
            continue
        p, per_unit = parse_price(t["text"])
        if p is not None and not per_unit:
            prices.append(p)
    prices = [p for p in prices if 0.05 <= p <= 500]  # plausibiliteitsgrens

    new_price = min(prices) if prices else 0.0
    orig_price = 0.0
    if len(prices) >= 2:
        hi = max(prices)
        if new_price > 0 and ORIG_MIN_RATIO <= hi / new_price <= ORIG_MAX_RATIO:
            orig_price = hi

    # dealtekst (ruimtelijk gesorteerd binnen de tegel)
    deal_text, deal_pct = detect_deal(group)

    # productnaam: alfabetische tokens die geen prijs/gewicht/deal zijn.
    # Enkel de grotere lettertokens (merk/producttitel) meenemen; de fijne
    # omschrijving ("assortiment poeder, caps, ...") valt onder de hoogtedrempel.
    name_cands = []
    for t in group:
        if t.get("consumed") or "price" in t:
            continue
        txt = t["text"]
        if parse_price(txt)[0] is not None or WEIGHT_RE.search(txt):
            continue
        if any(pat.search(txt) for pat, _ in DEAL_PATTERNS):
            continue
        if re.search(r"\d[-/]\d", txt):  # datums/reeksen ("29-07", "14-58")
            continue
        alpha = re.sub(r"[^a-zA-ZÀ-ÿ]", "", txt)
        if len(alpha) < 2:  # geen losse tekens/cijfers
            continue
        if alpha.lower() in NAME_STOPWORDS:  # banner/footer weren
            continue
        name_cands.append(t)

    name = ""
    if name_cands:
        max_h = max(t["h"] for t in name_cands)
        big = [t for t in name_cands if t["h"] >= NAME_HEIGHT_FACTOR * max_h]
        big.sort(key=lambda t: (t["cy"], t["cx"]))  # leesvolgorde
        name = " ".join(t["text"] for t in big[:NAME_MAX_WORDS]).strip()

    # minimale eisen: een naam plus óf een prijs óf een dealtekst
    if len(name) < 3 or (new_price == 0 and not deal_text):
        return None
    if not deal_text:
        deal_text = "Promoprijs"

    return {
        "item": name,
        "deal": deal_text,
        "_deal_pct": deal_pct,
        "newPrice": round(new_price, 2),
        "originalPrice": round(orig_price, 2),
        "category": categorize(name),
    }


# ============================================================================
# Normalisatie — spiegelt de savings-logica uit alvo.js
# ============================================================================
def slugify(s):
    return re.sub(r"^-|-$", "", re.sub(r"[^a-z0-9]+", "-", s.lower()))


def dutch_date(days=7):
    import datetime
    days_nl = ["zo", "ma", "di", "wo", "do", "vr", "za"]
    months = ["januari", "februari", "maart", "april", "mei", "juni", "juli",
              "augustus", "september", "oktober", "november", "december"]
    d = datetime.date.today() + datetime.timedelta(days=days)
    return f"{days_nl[d.weekday() + 1 if d.weekday() < 6 else 0]} {d.day} {months[d.month - 1]}"


def normalize(raw_deals):
    valid_until = dutch_date(7)
    seen, out = set(), []
    for d in raw_deals:
        if not d or not d.get("item") or not d.get("deal"):
            continue
        deal_id = f"alvo-{slugify(str(d['item']))}"
        if deal_id in seen:
            continue
        seen.add(deal_id)

        new_price = float(d.get("newPrice") or 0)
        orig_price = float(d.get("originalPrice") or 0)
        if orig_price > 0 and new_price > 0 and orig_price > new_price * 4:
            orig_price = 0.0

        deal_text = str(d.get("deal") or "")
        pct = d.get("_deal_pct")
        m_second = re.search(r"2e\s+(?:aan\s+)?-?(\d+)\s*%", deal_text, re.I)
        if m_second:
            savings = int(m_second.group(1))
        elif re.search(r"2\s*\+\s*1\s*gratis", deal_text, re.I):
            savings = 33
        elif re.search(r"1\s*\+\s*1\s*gratis", deal_text, re.I):
            savings = 50
        elif orig_price > 0 and new_price > 0 and orig_price > new_price:
            savings = round((orig_price - new_price) / orig_price * 100)
        elif pct:
            savings = min(99, max(0, int(pct)))
        else:
            savings = 0

        out.append({
            "id": deal_id,
            **STORE_META,
            "item": str(d["item"]),
            "deal": deal_text,
            "category": d.get("category") or "Overig",
            "originalPrice": orig_price,
            "newPrice": new_price,
            "savings": savings,
            "validUntil": valid_until,
            "hot": savings >= 30,
        })
    return out


# ============================================================================
# Main
# ============================================================================
def parse_page(image):
    tokens = ocr_tokens(image)
    merge_split_prices(tokens)
    groups = cluster_tokens(tokens)
    return [d for d in (build_deal(g) for g in groups) if d]


def main():
    args = sys.argv[1:]
    if args:
        sources = args
    else:
        stdin = sys.stdin.read().strip()
        sources = json.loads(stdin) if stdin else []

    raw = []
    for src in sources:
        try:
            raw.extend(parse_page(load_image(src)))
        except Exception as e:  # noqa: BLE001 — per-pagina falen mag niet alles stoppen
            print(f"[alvo_ocr] fout op {src}: {e}", file=sys.stderr)

    deals = normalize(raw)
    json.dump(deals, sys.stdout, ensure_ascii=False)


if __name__ == "__main__":
    main()
