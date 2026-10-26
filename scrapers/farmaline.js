// Farmaline promo-scraper — undici, geen proxy/browser. Geport van app/api/scrape-farmaline.
// De speciale-aanbiedingen-pagina is een Next.js-app die Algolia-promoresultaten server-side
// in de RSC-payload embedt. We parsen de "hits":[...]-arrays, pagineren via ?page=N (30/pagina)
// tot leeg, mergen FR-namen op `upid`. Schrijft Supabase cache-key "farmaline".
import { logScrape } from "../lib/logScrape.js";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36";
const PAGE_SIZE = 30;
const MAX_PAGES = 40;

const _DAYS = ["zo", "ma", "di", "wo", "do", "vr", "za"];
const _MONTHS = ["januari", "februari", "maart", "april", "mei", "juni", "juli", "augustus", "september", "oktober", "november", "december"];
function dutchDate(daysFromNow = 14) {
  const d = new Date();
  d.setDate(d.getDate() + daysFromNow);
  return `${_DAYS[d.getDay()]} ${d.getDate()} ${_MONTHS[d.getMonth()]}`;
}

function matchBracket(s, i) {
  const open = s[i], close = open === "[" ? "]" : "}";
  let depth = 0, inStr = false, esc = false;
  for (let j = i; j < s.length; j++) {
    const c = s[j];
    if (inStr) { if (esc) esc = false; else if (c === "\\") esc = true; else if (c === '"') inStr = false; }
    else if (c === '"') inStr = true;
    else if (c === open) depth++;
    else if (c === close) { depth--; if (depth === 0) return s.slice(i, j + 1); }
  }
  return null;
}

function extractHits(html) {
  const un = html.replace(/\\"/g, '"').replace(/\\\\/g, "\\").replace(/\\n/g, " ");
  const hits = [];
  const re = /"hits"\s*:\s*\[/g;
  let m;
  while ((m = re.exec(un))) {
    const arr = matchBracket(un, m.index + m[0].length - 1);
    if (!arr) continue;
    try {
      const parsed = JSON.parse(arr);
      if (Array.isArray(parsed)) hits.push(...parsed);
    } catch { /* onvolledig chunk */ }
  }
  return hits;
}

async function fetchPage(base, page) {
  const res = await fetch(`${base}?page=${page}`, { headers: { "User-Agent": UA, "Accept-Language": "nl-BE,nl;q=0.9" }, cache: "no-store" });
  if (!res.ok) return [];
  return extractHits(await res.text());
}

async function scrapeAll(base, onlyPromo = true) {
  const byId = new Map();
  for (let page = 1; page <= MAX_PAGES; page++) {
    const hits = await fetchPage(base, page);
    let promoOnPage = 0;
    for (const h of hits) {
      const o = h.best_offer || {};
      const id = h.upid || o.id;
      if (!id) continue;
      if (onlyPromo && !(o.discount > 0)) continue;
      promoOnPage++;
      if (!byId.has(id)) byId.set(id, h);
    }
    if (promoOnPage < PAGE_SIZE) break;
  }
  return byId;
}

function mapDeal(h, frName) {
  const o = h.best_offer || {};
  const id = h.upid || o.id;
  const now = o.price?.amount != null ? o.price.amount / 100 : null;
  const old = o.strike_price?.amount != null ? o.strike_price.amount / 100
    : (o.listPrice ? o.listPrice / 100 : null);
  const rel = typeof h.deeplink === "string" ? h.deeplink : "";
  const productUrl = rel
    ? (rel.startsWith("http") ? rel : `https://www.farmaline.be/${rel.replace(/^\//, "")}`)
    : "https://www.farmaline.be/nl/speciale-aanbiedingen-nl/";
  return {
    id: `farmaline-${id}`,
    store: "Farmaline",
    storeColor: "#e2001a",
    storeLogo: "FA",
    item: h.productName || h.name || "",
    item_fr: frName || undefined,
    brand: (h.brand || h.brandName || "") + "" || undefined,
    category: "Verzorging",
    newPrice: now,
    originalPrice: old,
    savings: typeof o.discount === "number" ? o.discount : 0,
    deal: typeof o.discount === "number" && o.discount > 0 ? `-${o.discount}%` : "Promo",
    emoji: "💊",
    validUntil: dutchDate(14),
    hot: (o.discount || 0) >= 30,
    image: h.image || h.imageUrl || null,
    productUrl,
  };
}

async function supabaseWrite(key, data) {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) throw new Error("Supabase env vars ontbreken");
  const res = await fetch(`${SUPABASE_URL}/rest/v1/cache`, {
    method: "POST",
    headers: {
      apikey: SUPABASE_SERVICE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
      "Content-Type": "application/json",
      Prefer: "resolution=merge-duplicates",
    },
    body: JSON.stringify({ key, data, updated_at: new Date().toISOString() }),
  });
  if (!res.ok) throw new Error(`supabaseWrite(${key}) ${res.status}: ${(await res.text()).slice(0, 200)}`);
}

export async function scrapeFarmaline() {
  const t = Date.now();
  try {
    const [nl, fr] = await Promise.all([
      scrapeAll("https://www.farmaline.be/nl/speciale-aanbiedingen-nl/"),
      scrapeAll("https://www.farmaline.be/fr/offres-speciales-fr/"),
    ]);
    const frName = new Map();
    for (const [id, h] of fr) frName.set(id, h.productName || h.name);

    const deals = [...nl.values()]
      .map((h) => mapDeal(h, frName.get(h.upid || h.best_offer?.id)))
      .filter((d) => d.item && d.newPrice > 0 && d.originalPrice > d.newPrice);

    const durationMs = Date.now() - t;
    if (deals.length > 0) await supabaseWrite("farmaline", deals);
    await logScrape({ source: "farmaline", dealCount: deals.length, errors: [], durationMs }).catch(() => {});
    return { ok: true, deals: deals.length, nl: nl.size, fr: fr.size };
  } catch (err) {
    const durationMs = Date.now() - t;
    console.error("[farmaline] error:", err.message);
    await logScrape({ source: "farmaline", dealCount: 0, errors: [err.message], durationMs }).catch(() => {});
    throw err;
  }
}
