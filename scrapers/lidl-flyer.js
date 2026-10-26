// Lidl scraper — via de Publitas-folder text-laag (spreads.json -> pages[].text).
// Lidl BE verwijderde sept 2026 de gestructureerde weekaanbiedingen van de site
// (de /aanbiedingen-deze-week pagina is nu een lege hub, producten client-side).
// De weekfolder (folder-nl.lidl.be, Publitas-viewer) is de enige bron met echte
// voedingsdeals + prijzen. Publitas levert per pagina een OCR-tekstlaag
// (spreads.json -> pages[].text) — geen vision/afbeeldings-OCR nodig.
//
// De tekst is een platgeslagen 2-koloms lay-out: productnaam, bullets, `nr.NNNNN`,
// prijs en `-NN%` staan door elkaar en de prijzen "zweven" los van hun product.
// Betrouwbaarheids-truc: ACTIEPRIJZEN gebruiken een PUNT (1.55), EENHEIDSPRIJZEN een
// KOMMA (9,98 EUR/kg). De eenheidsregel staat pal bij het eigen artikelnummer, dus
// `hoeveelheid × eenheidsprijs ≈ actieprijs` (0,4kg × 9,98 = 3,99). Die afgeleide prijs
// verankert welk zwevend punt-getal bij het product hoort — de parser bindt op basis
// daarvan en slaat dubbelzinnige gevallen over (meerdere nr's die één prijsregio delen).
// Conservatief: liever een deal missen dan een foute prijs tonen.
//
// `nr.NNNNN` is taal-onafhankelijk -> NL/FR-join op artikelnummer.
// De folder loopt over meerdere weken tegelijk; de einddatum staat per pagina in de
// tekst ("... t.e.m. za. 26/09"). Verlopen pagina's worden overgeslagen.

import { Agent } from "undici";

// www.lidl.be stuurt grote response-headers (Set-Cookie e.d.) die undici's
// standaard 16KB-limiet overschrijden (UND_ERR_HEADERS_OVERFLOW). Scoped agent.
const bigHeaderAgent = new Agent({ maxHeaderSize: 1 << 20 });

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";
const FOLDERS_PAGE = "https://www.lidl.be/c/nl-BE/folders-magazines/s10008101";

const _DAYS = ["zo", "ma", "di", "wo", "do", "vr", "za"];
const _MONTHS = ["januari", "februari", "maart", "april", "mei", "juni", "juli", "augustus", "september", "oktober", "november", "december"];
const NUM = (s) => { const n = parseFloat(String(s).replace(",", ".")); return Number.isFinite(n) ? n : 0; };

function fmtDutch(d) { return `${_DAYS[d.getDay()]} ${d.getDate()} ${_MONTHS[d.getMonth()]}`; }

async function supabaseWrite(data) {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) throw new Error("Missing Supabase env vars");
  const res = await fetch(`${SUPABASE_URL}/rest/v1/cache`, {
    method: "POST",
    headers: {
      apikey: SUPABASE_SERVICE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
      "Content-Type": "application/json",
      Prefer: "resolution=merge-duplicates",
    },
    body: JSON.stringify({ key: "lidl", data, updated_at: new Date().toISOString() }),
  });
  if (!res.ok) throw new Error(`Supabase write failed: ${res.status}`);
}

// Einddatum uit de pagina-tekst: "... t.e.m. za. 26/09" -> Date. Jaargrens: als de
// maand ver in het verleden lijkt (Dec->Jan) tel er een jaar bij op.
function parseEndDate(text) {
  const m = text.match(/t\.e\.m\.?\s*[a-z]{0,3}\.?\s*(\d{1,2})[/-](\d{1,2})/i);
  if (!m) return null;
  const now = new Date();
  const day = +m[1], month = +m[2] - 1;
  let year = now.getFullYear();
  if (month < now.getMonth() - 6) year++;
  return new Date(year, month, day);
}

async function fetchFolderSlug() {
  const res = await fetch(FOLDERS_PAGE, {
    headers: { "User-Agent": UA, "Accept-Language": "nl-BE,nl;q=0.9" },
    signal: AbortSignal.timeout(20_000),
    dispatcher: bigHeaderAgent,
  });
  if (!res.ok) throw new Error(`folders-magazines HTTP ${res.status}`);
  const html = await res.text();
  const m = html.match(/folder-nl\.lidl\.be\/(nl-folder-[0-9-]+)/);
  if (!m) throw new Error("Lidl: folder-slug niet gevonden op folders-magazines");
  return m[1];
}

// Publitas spreads.json -> lijst pagina's met tekst + einddatum. Het `version`-token
// is niet vereist (200 zonder). Verlopen pagina's overslaan.
async function fetchPages(slug) {
  const host = slug.startsWith("fr-") ? "folder-fr.lidl.be" : "folder-nl.lidl.be";
  const res = await fetch(`https://${host}/${slug}/spreads.json`, {
    headers: { "User-Agent": UA },
    signal: AbortSignal.timeout(20_000),
    dispatcher: bigHeaderAgent,
  });
  if (!res.ok) throw new Error(`spreads.json HTTP ${res.status}`);
  const spreads = await res.json();
  if (!Array.isArray(spreads) || !spreads.length) throw new Error("spreads.json leeg");

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const pages = [];
  const ends = [];
  for (const sp of spreads) for (const pg of sp.pages || []) {
    const text = (pg.text || "").trim();
    if (text.length < 40) continue;
    const end = parseEndDate(text);
    if (end) ends.push(end.getTime());
    pages.push({ text, end });
  }
  // Flyer-brede fallback-einddatum = meest voorkomende geparste einddatum (of +7d).
  const fallbackEnd = ends.length
    ? new Date(ends.sort((a, b) => a - b)[Math.floor(ends.length / 2)])
    : (() => { const d = new Date(); d.setDate(d.getDate() + 7); return d; })();

  return pages
    .map(p => ({ ...p, end: p.end || fallbackEnd }))
    .filter(p => p.end >= today);
}

// --- Tekst-parser -----------------------------------------------------------

const BULLET = /^[•·∙�\-*]/;                 // •, ·, ∙, replacement-char, -, *
// Artikelnummer: NL "nr. 83242", FR "n° 83242" (het ° komt in de OCR als ° of �).
const NR_CAP = /(?:nr\.?|n[°º�])\s*(\d{4,7})/i;
const NR_START = /^(?:nr\.?|n[°º�])\s*\d{4,7}/i;
const NR_ANY = /(?:nr\.?|n[°º�])\s*\d/i;
const PERIOD_PRICE = /(?<![\d.,])(\d{1,3}\.\d{2})(?![\d.,])/g;    // actieprijs: PUNT (1.55)
// Optionele multipack-multiplier "6 x 65 g - 2,23 EUR/kg" -> 6 × 65 g. Zonder ×N-groep
// zou de afgeleide prijs 1/N te laag zijn (bug: keizerbroodje 6×65g gaf 0,14 i.p.v. 0,87).
const UNIT_LINE = /(?:(\d+)\s*[x×]\s*)?(\d+(?:[.,]\d+)?)\s*(kg|g|ml|cl|l)\b[^0-9]{0,4}(\d+[.,]\d{2})\s*EUR\s*\/\s*(kg|l)/i;
const PCT = /-\s*(\d{1,2})\s*%/;
const QTY_ONLY = /^\d+(?:[.,]\d+)?\s*(kg|g|ml|cl|l|stuks?|x)\b/i;
// Regels die geen productnaam zijn (secties/labels/merken-los/marketing).
const NOISE = /^(actie|met lidl plus|vanaf|t\.e\.m|nieuw|super|xxl|bio|nutri|per stuk|geldig|assortiment|gratis|voor\b|\d|onze?\b|al ons|al onze|nl \d)/i;

function toBaseQty(val, unit) {
  const n = NUM(val);
  switch (unit.toLowerCase()) {
    case "g": return n / 1000;   // -> kg
    case "kg": return n;
    case "ml": return n / 1000;  // -> l
    case "cl": return n / 100;
    case "l": return n;
    default: return 0;
  }
}

function isSkip(l) {
  return BULLET.test(l) || QTY_ONLY.test(l) || /EUR\s*\//.test(l) ||
    /^-?\s*\d+([.,]\d+)?\s*%?$/.test(l) || /^-?\s*\d{1,3}\.\d{2}/.test(l);
}
const startsUpper = (l) => /^[A-ZÀ-Ÿ]/.test(l);
const isAllCaps = (l) => { const let_ = l.replace(/[^A-Za-zÀ-ÿ]/g, ""); return let_.length >= 2 && let_ === let_.toUpperCase(); };

// Naam = de tekst-regels net boven het bullet-blok van dít product. De folder wikkelt
// bullets over meerdere regels (continuaties zonder bullet-teken), dus we ankeren op de
// BOVENSTE bullet van het blok en nemen de tekst daarboven — vanaf de laatste titel-regel
// (drop een eventuele naam-staart van het vorige product), met een eventueel merk in
// HOOFDLETTERS ervoor.
function nameAbove(lines, nrIdx) {
  // Bovenste bullet van het blok (binnen 10 regels boven nr).
  let top = -1;
  for (let j = nrIdx - 1; j >= Math.max(0, nrIdx - 10); j--) {
    if (BULLET.test(lines[j])) top = j;
    else if (NR_ANY.test(lines[j])) break;
  }
  const anchor = top >= 0 ? top : nrIdx; // geen bullets -> tekst direct boven nr

  // Verzamel aaneengesloten tekst-regels boven het anker (leesvolgorde).
  const above = [];
  for (let j = anchor - 1; j >= Math.max(0, anchor - 4); j--) {
    const l = lines[j].replace(PERIOD_PRICE, "").replace(/[•·�*]/g, "").trim();
    if (!l || isSkip(lines[j]) || NR_ANY.test(lines[j]) || NOISE.test(l)) break;
    above.unshift(l);
  }
  if (!above.length) return "";

  // Naam-start = laatste titel-regel (start hoofdletter, niet louter HOOFDLETTERS).
  let start = -1;
  for (let k = above.length - 1; k >= 0; k--) if (startsUpper(above[k]) && !isAllCaps(above[k])) { start = k; break; }
  if (start === -1) start = above.findIndex(startsUpper); // anders eerste hoofdletter-regel
  if (start === -1) return "";
  // Merk in HOOFDLETTERS er direct boven? meenemen.
  if (start > 0 && isAllCaps(above[start - 1])) start--;

  return above.slice(start).join(" ").replace(/\s+/g, " ").trim();
}

function dealTextFrom(win, savings) {
  const m = win.match(/2e\s+aan\s*-?\s*\d+\s*%/i) || win.match(/[123]\s*\+\s*1\s*\**\s*gratis/i);
  if (m) return m[0].replace(/\s+/g, " ").replace(/\*/g, "").trim();
  if (savings > 0) return `-${savings}%`;
  return "Actieprijs";
}

// Parseert één pagina: per `nr.`-anker bind naam + prijs. Actieprijs wordt verankerd
// aan de afgeleide prijs (hoeveelheid × eenheidsprijs); dubbelzinnige nr-clusters
// (twee nr's binnen 2 regels met één prijsregio) worden overgeslagen.
function parsePageDeals(lines, validUntil) {
  const out = [];
  const nrIdx = [];
  for (let i = 0; i < lines.length; i++) if (NR_START.test(lines[i])) nrIdx.push(i);

  for (let k = 0; k < nrIdx.length; k++) {
    const i = nrIdx[k];
    const nr = lines[i].match(NR_CAP)[1];

    // Venster: van vorige nr (excl.) tot volgende nr (excl.), begrensd.
    const from = Math.max(k > 0 ? nrIdx[k - 1] + 1 : 0, i - 8);
    const to = Math.min(k + 1 < nrIdx.length ? nrIdx[k + 1] : lines.length, i + 6);
    const win = lines.slice(from, to).join(" ");

    // Dubbelzinnig: nog een nr binnen 2 regels -> gedeelde prijsregio, overslaan.
    if (nrIdx[k + 1] != null && nrIdx[k + 1] - i <= 2) continue;
    if (k > 0 && i - nrIdx[k - 1] <= 2) continue;

    // Afgeleide prijs uit de eenheidsregel (hoeveelheid × EUR/kg|l).
    const um = win.match(UNIT_LINE);
    const derived = um ? (um[1] ? +um[1] : 1) * toBaseQty(um[2], um[3]) * NUM(um[4]) : 0;

    // Alle punt-prijzen in het venster.
    const prices = [...win.matchAll(PERIOD_PRICE)].map(m => NUM(m[1])).filter(p => p >= 0.2 && p < 1000);
    const pctM = win.match(PCT);
    const pct = pctM ? +pctM[1] : 0;

    const secondHalf = /2e\s+aan\s*-?\s*(\d+)\s*%/i.test(win); // "2e aan -20%" = geen echte oude prijs

    let newP = 0, oldP = 0, confirmed = false;
    if (derived) {
      // De afgeleide prijs komt uit de EIGEN eenheidsregel van dit product en is dus
      // betrouwbaar. Een punt-prijs enkel gebruiken als die de afgeleide bevestigt
      // (±15%); anders is het een vreemde prijs uit een naburige kolom (OCR-leesvolgorde)
      // die de afgeleide NIET mag overrulen. Bug: Halloweenmix pikte 14.54 i.p.v. 2.99,
      // Groene olijven 4.79 i.p.v. 2.65 (vreemde losse punt-prijs won van de afgeleide).
      let best = null, bestDiff = Infinity;
      for (const p of prices) { const d = Math.abs(p - derived) / derived; if (d < bestDiff) { bestDiff = d; best = p; } }
      newP = (best != null && bestDiff <= 0.15) ? best : +derived.toFixed(2);
      confirmed = true;
    } else if (prices.length === 1) {
      newP = prices[0]; // geen eigen eenheidsregel: één losse prijs, onbevestigd
    }
    // Dubbelzinnig (geen prijs, of meerdere niet-verankerde prijzen) -> overslaan.
    if (!newP) continue;
    // Niet-verankerde losse prijs boven een voedsel-plausibele grens -> wantrouwen.
    if (!confirmed && newP >= 20) continue;

    // Oude prijs: enkel een hoger punt-getal accepteren als het consistent is met %
    // (h × (1-pct) ≈ new). Zonder pct: enkel bij afgeleide bevestiging + redelijke ratio.
    if (!secondHalf) {
      // Enkel een oude prijs tonen als een %-korting hem bevestigt (h × (1-pct) ≈ new).
      // Zonder % geen "oude prijs" gokken — kruis-contaminatie tussen kolommen.
      if (pct) {
        for (const h of prices.filter(p => p > newP * 1.05)) {
          if (Math.abs(h * (1 - pct / 100) - newP) / newP <= 0.15) { oldP = h; break; }
        }
      }
    }

    const name = nameAbove(lines, i);
    if (name.length < 3 || /^\d/.test(name)) continue;

    let savings;
    const m2 = win.match(/2e\s+aan\s*-?\s*(\d+)\s*%/i);
    if (m2) savings = Math.round(+m2[1] / 2);           // 2e aan -N% ≈ N/2 over 2 stuks
    else if (oldP > newP) savings = Math.round((oldP - newP) / oldP * 100);
    else if (/1\s*\+\s*1\s*gratis/i.test(win)) savings = 50;
    else if (/2\s*\+\s*1\s*gratis/i.test(win)) savings = 33;
    else if (/3\s*\+\s*1\s*gratis/i.test(win)) savings = 25;
    else savings = pct;

    out.push({
      nr,
      item: name,
      newPrice: newP,
      originalPrice: oldP > newP ? oldP : newP,
      savings,
      deal: dealTextFrom(win, savings),
      validUntil,
    });
  }
  return out;
}

function normLines(text) {
  return text.split("\n").map(l => l.trim()).filter(Boolean);
}

// Parseer alle (niet-verlopen) pagina's; dedup op nr.
function parseAll(pages) {
  const seen = new Set();
  const deals = [];
  for (const p of pages) {
    const vu = fmtDutch(p.end);
    for (const d of parsePageDeals(normLines(p.text), vu)) {
      if (seen.has(d.nr)) continue;
      seen.add(d.nr);
      deals.push(d);
    }
  }
  return deals;
}

// Alleen namen (voor FR-join op artikelnummer).
function parseNames(pages) {
  const map = {};
  for (const p of pages) for (const d of parsePageDeals(normLines(p.text), "")) {
    if (d.item && !map[d.nr]) map[d.nr] = d.item;
  }
  return map;
}

// Lidl Plus app-API (publiek, geen auth). Geeft voor BE GEEN prijzen, maar wel een
// promo-afbeelding + geldigheid per offer, gekoppeld via `productIds` die exact de
// folder-artikelnummers (`nr.`) zijn. We gebruiken het enkel om folder-deals een
// afbeelding te geven (de folder levert er zelf geen). Faalt dit, dan blijft image null.
const LIDLPLUS_HEADERS = {
  Accept: "application/json",
  "Accept-Language": "nl-BE",
  "User-Agent": "LidlPlus/17.0.5 Android okhttp/4.12.0",
  "X-Client-Version": "17.0.5",
  "X-Client-Platform": "android",
};
async function fetchLidlPlusImages() {
  const byNr = {};
  try {
    const sr = await fetch("https://stores.lidlplus.com/api/v4/BE", {
      headers: LIDLPLUS_HEADERS, signal: AbortSignal.timeout(15_000),
    });
    if (!sr.ok) throw new Error(`stores HTTP ${sr.status}`);
    const stores = await sr.json();
    const list = Array.isArray(stores) ? stores : (stores.stores || []);
    const storeKey = list.find(s => s.storeKey)?.storeKey; // offers zijn nationaal — 1 winkel volstaat
    if (!storeKey) throw new Error("geen storeKey");

    const or = await fetch(`https://offers.lidlplus.com/app/api/v4/BE/${storeKey}/offers`, {
      headers: LIDLPLUS_HEADERS, signal: AbortSignal.timeout(15_000),
    });
    if (!or.ok) throw new Error(`offers HTTP ${or.status}`);
    const { offers = [] } = await or.json();
    for (const o of offers) {
      if (!o.imageUrl) continue;
      for (const pid of o.productIds || []) byNr[String(parseInt(pid, 10))] = o.imageUrl;
    }
  } catch (e) {
    console.warn("[lidl] Lidl Plus-afbeeldingen overgeslagen:", e.message);
  }
  return byNr;
}

export async function scrapeLidl() {
  const nlSlug = await fetchFolderSlug();
  const nlPages = await fetchPages(nlSlug);
  if (!nlPages.length) throw new Error("Lidl: geen actieve folder-pagina's");

  const parsed = parseAll(nlPages);

  // FR-namen (best effort) — zelfde folder, fr-slug; join op artikelnummer.
  let frNames = {};
  try {
    const frPages = await fetchPages(nlSlug.replace(/^nl-/, "fr-"));
    if (frPages.length) frNames = parseNames(frPages);
  } catch (e) {
    console.warn("[lidl] FR-namen overgeslagen:", e.message);
  }

  const imgByNr = await fetchLidlPlusImages();

  const deals = parsed.map(d => ({
    id: `lidl-${d.nr}`,
    store: "Lidl",
    storeColor: "#0050AA",
    storeLogo: "L",
    item: d.item,
    ...(frNames[d.nr] && { item_fr: frNames[d.nr] }),
    deal: d.deal,
    originalPrice: d.originalPrice,
    newPrice: d.newPrice,
    savings: d.savings,
    emoji: "🛒",              // /api/deals herberekent op categorie
    validUntil: d.validUntil,
    hot: d.savings >= 30,
    image: imgByNr[String(parseInt(d.nr, 10))] || null, // via Lidl Plus-offer (nr == productId)
  }));

  console.log(`[lidl] ${deals.length} deals uit folder ${nlSlug}`);
  if (deals.length === 0) throw new Error("Geen Lidl-deals geparseerd");

  await supabaseWrite(deals);
  return { total: deals.length };
}
