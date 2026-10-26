// Carrefour scraper — Salesforce Commerce Cloud AJAX (Search-UpdateGrid) via Brightdata
// residentiële proxy (undici). Geen Playwright/Scraping Browser meer: het endpoint levert
// statische HTML (geen JS-render nodig), de SB-exit werd door Carrefour ge-429't, en undici
// is 10-100x goedkoper. De residentiële proxy (poort 22225) roteert het exit-IP per request.
import { ProxyAgent } from "undici";
import { parse as parseHtml } from "node-html-parser";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// HTML-entiteiten in het GTM-JSON-attribuut decoderen (&amp; als laatste, anders dubbel).
function decodeEntities(s) {
  return (s || "")
    .replace(/&quot;/g, '"').replace(/&#0?39;/g, "'")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
}

const _MONTHS = ["januari","februari","maart","april","mei","juni","juli","augustus","september","oktober","november","december"];

function slugify(str) {
  return str.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function parseValidUntil(dateStr) {
  // Formaat: "04/05/2026"
  if (!dateStr) return "";
  const m = dateStr.match(/(\d{2})\/(\d{2})\/(\d{4})/);
  if (!m) return "";
  const d = new Date(`${m[3]}-${m[2]}-${m[1]}`);
  if (isNaN(d)) return "";
  return `${d.getDate()} ${_MONTHS[d.getMonth()]}`;
}

function categorize(name) {
  const n = (name || "").toLowerCase();
  if (/shampoo|deo|tandpast|verzorg|lotion|huid|haar|zeep|parfum|make-up|cosmet|scheer|body|zonnebrand|spf/.test(n)) return "Verzorging";
  if (/wasmiddel|schoonmaak|reinig|vaat|huishoud|afval|toilet|papier|was |doek|spons/.test(n)) return "Huishouden";
  if (/snack|chips|koek|chocola|snoep|noot|ontbijt|muesli|granola|koffie|thee|drank|frisdrank|bier|wijn|cola|sap/.test(n)) return "Bakkerij & Snacks";
  if (/vlees|vis|kip|zalm|ham|worst|charcuterie/.test(n)) return "Vlees & Vis";
  if (/yoghurt|kaas|zuivel|boter|eieren|melk/.test(n)) return "Zuivel";
  if (/groenten|fruit|aardappel|salade/.test(n)) return "Groenten & Fruit";
  if (/pasta|rijst|soep|saus|conserven|droogwaren/.test(n)) return "Droogwaren";
  return "Overig";
}

// Geeft { savings, multibuy }. multibuy = de korting geldt niet per stuk (2de stuk,
// bundel, gratis) → effectief % over de aankoop, en GEEN was-prijs terugrekenen
// (de stuksprijs is onveranderd). Volgorde: multi-buy-patronen VÓÓR de kale "(\d+)%",
// anders pakt "2de aan -40%" de headline (40) i.p.v. effectief (20).
function parseSavings(promoName) {
  if (!promoName) return { savings: 0, multibuy: false };
  const n = promoName.toLowerCase();
  // "2de aan -40%" / "3de aan -60%": alleen het N-de stuk is afgeprijsd → effectief = X/N.
  const nth = promoName.match(/(\d+)\s*(?:de|e|ste)?\s*(?:aan|tegen)\s*-?\s*(\d+)\s*%/i);
  if (nth) {
    const q = parseInt(nth[1]), pct = parseInt(nth[2]);
    if (q >= 2 && pct > 0) return { savings: Math.round(pct / q), multibuy: true };
  }
  // "1+1 gratis" / "2+1" → 50% / 33%
  if (/1\s*\+\s*1|2e\s*gratis/i.test(n)) return { savings: 50, multibuy: true };
  if (/2\s*\+\s*1/i.test(n)) return { savings: 33, multibuy: true };
  // "2e halve prijs" → 25%
  if (/halve\s*prijs|demi.tarif/i.test(n)) return { savings: 25, multibuy: true };
  // Kale afprijzing: "-40%" / "40% korting" → echte stuks-markdown.
  const pct = promoName.match(/(\d+)\s*%/);
  if (pct) return { savings: parseInt(pct[1]), multibuy: false };
  return { savings: 0, multibuy: false };
}

async function supabaseWrite(deals) {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) throw new Error("Missing Supabase env vars");
  const res = await fetch(`${SUPABASE_URL}/rest/v1/cache`, {
    method: "POST",
    headers: {
      apikey: SUPABASE_SERVICE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
      "Content-Type": "application/json",
      Prefer: "resolution=merge-duplicates",
    },
    body: JSON.stringify({ key: "carrefour", data: deals, updated_at: new Date().toISOString() }),
  });
  if (!res.ok) throw new Error(`Supabase write failed: ${res.status} ${await res.text()}`);
}

// Demandware pipeline-pad (het friendly-locale pad /nl/Search-ShowAjax geeft sinds sep 2026 404).
// Search-UpdateGrid = wat de live "Toon meer"-knop gebruikt; pmin=0,01 sluit prijsloze items uit.
// locale: "default" = NL, "fr_BE" = FR.
const PAGE_SIZE = 100; // ~3000 promo-producten → binnen 50 iteraties
function gridUrl(locale, start) {
  return `https://www.carrefour.be/on/demandware.store/Sites-carrefour-be-Site/${locale}/Search-UpdateGrid?cgid=allpromotions&pmin=0%2C01&start=${start}&sz=${PAGE_SIZE}`;
}

// Haal één grid-pagina op via de residentiële proxy, met retry op 429/fout (nieuwe ProxyAgent = nieuw exit-IP).
async function fetchGridPage(user, pass, host, locale, start) {
  for (let attempt = 0; attempt < 3; attempt++) {
    // Brightdata residentiële proxy SSL-bumpt met een eigen (verlopen) cert → verificatie
    // van de tunnel uitzetten (verkeer naar carrefour.be blijft via de betaalde proxy).
    const dispatcher = new ProxyAgent({
      uri: `http://${user}:${pass}@${host}:22225`,
      requestTls: { rejectUnauthorized: false },
    });
    try {
      const res = await fetch(gridUrl(locale, start), {
        dispatcher,
        headers: { "User-Agent": UA, Accept: "text/html,*/*" },
        signal: AbortSignal.timeout(30_000),
      });
      if (res.ok) return await res.text();
      if (res.status === 429) { await sleep(2000 * (attempt + 1)); continue; }
      return null; // andere status: geef op voor deze pagina
    } catch {
      await sleep(1000);
    } finally {
      dispatcher.close().catch(() => {});
    }
  }
  return null;
}

// Pagineer een locale met beperkte concurrency; stopt bij de eerste lege pagina (einde catalogus).
// Elke request krijgt een eigen ProxyAgent → eigen exit-IP → minder kans op 429 dan sequentieel op één IP.
async function fetchAllItems(user, pass, host, locale, maxPages = 40, concurrency = 6) {
  const items = [];
  for (let base = 0; base < maxPages; base += concurrency) {
    const starts = [];
    for (let i = 0; i < concurrency && base + i < maxPages; i++) starts.push((base + i) * PAGE_SIZE);
    const htmls = await Promise.all(starts.map((s) => fetchGridPage(user, pass, host, locale, s)));
    let hitEnd = false;
    for (const html of htmls) {
      if (html === null) continue; // transiente fout: sla deze pagina over, stop niet
      const batch = extractItems(html);
      if (batch.length === 0) { hitEnd = true; continue; }
      items.push(...batch);
    }
    if (hitEnd) break; // lege pagina = einde catalogus (rest is ook leeg)
  }
  return items;
}

// Parse een grid-HTML-fragment naar ruwe product-items (GTM-JSON + promo-tag + geldigheid + beeld).
function extractItems(html) {
  const root = parseHtml(html);
  const results = [];
  for (const el of root.querySelectorAll("[data-select-promotion-event-object]")) {
    let obj;
    try { obj = JSON.parse(decodeEntities(el.getAttribute("data-select-promotion-event-object"))); } catch { continue; }
    const item = obj?.ecommerce?.items?.[0];
    if (!item?.item_name) continue;

    const promoTag = el.querySelector(".promo-tag-text");
    const promoName = (promoTag?.text || item.promotion_name || "").trim();

    const tooltip = el.querySelector(".promo-validity-date");
    const dateMatch = (tooltip?.text || "").match(/(\d{2}\/\d{2}\/\d{4})/);
    // Filter: sla jaaracties (t/m 31 december) over.
    if (dateMatch && dateMatch[1].startsWith("31/12")) continue;

    const img = el.querySelector("img.tile-image") || el.querySelector("img");
    results.push({
      id: item.item_id || "",
      name: item.item_name,
      brand: (item.item_brand && item.item_brand !== "undefined") ? item.item_brand : "",
      price: item.price || 0,
      promoName,
      validUntil: dateMatch ? dateMatch[1] : "",
      image: img?.getAttribute("src") || img?.getAttribute("data-src") || "",
    });
  }
  return results;
}

export async function scrapeCarrefour() {
  const user = process.env.BRIGHTDATA_USER;
  const pass = process.env.BRIGHTDATA_PASS;
  const host = process.env.BRIGHTDATA_HOST || "brd.superproxy.io";
  if (!user || !pass) throw new Error("Missing BRIGHTDATA_USER / BRIGHTDATA_PASS");

  const deals = [];
  const seen = new Set();

  // NL-producten (locale "default"), parallel gepagineerd.
  const nlItems = await fetchAllItems(user, pass, host, "default");
  for (const item of nlItems) {
    const key = `carrefour-${item.id || slugify(item.name)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const { savings, multibuy } = parseSavings(item.promoName);
    const newPrice = item.price || 0;
    // Geen was-prijs verzinnen bij multi-buy: de stuksprijs daalt niet. Enkel bij een
    // echte stuks-afprijzing is newPrice/(1-%) de werkelijke oude prijs.
    const originalPrice = !multibuy && savings > 0 && newPrice > 0
      ? Math.round(newPrice / (1 - savings / 100) * 100) / 100
      : 0;
    deals.push({
      id: key,
      store: "Carrefour",
      storeColor: "#004E9F",
      storeLogo: "CF",
      emoji: "🛒",
      item: item.name,
      deal: item.promoName || "Promo",
      category: categorize(item.name),
      originalPrice,
      newPrice,
      savings,
      image: item.image || null,
      validUntil: parseValidUntil(item.validUntil),
      hot: savings >= 40,
      ...(item.brand && { brand: item.brand }),
    });
  }
  console.log(`[carrefour] NL: ${deals.length} deals`);

  // Primaire data meteen wegschrijven — FR-namen zijn best-effort verrijking.
  if (deals.length > 0) await supabaseWrite(deals);

  // FR-namen (locale "fr_BE"), matchen op item_id, fallback prijs+beeld.
  try {
    const frItems = await fetchAllItems(user, pass, host, "fr_BE");
    const frById = new Map();
    const frByPrice = new Map();
    for (const item of frItems) {
      if (item.id) frById.set(`carrefour-${item.id}`, item.name);
      if (item.price && item.image) frByPrice.set(`${item.price}|${item.image}`, item.name);
    }
    let matched = 0;
    for (const deal of deals) {
      const fr = frById.get(deal.id) || (deal.newPrice && deal.image ? frByPrice.get(`${deal.newPrice}|${deal.image}`) : undefined);
      if (fr) { deal.item_fr = fr; matched++; }
    }
    console.log(`[carrefour] FR namen: ${frById.size} by ID, ${matched} matched`);
    if (matched > 0 && deals.length > 0) await supabaseWrite(deals); // herschrijf met FR-namen
  } catch (err) {
    console.log(`[carrefour] FR fetch fout: ${err.message}`);
  }

  return { total: deals.length };
}
