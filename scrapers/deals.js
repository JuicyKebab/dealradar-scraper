// Aldi + Jumbo scraper — geport van app/api/scrape. Schrijft Supabase cache-key "deals".
// (Lidl zit al op Railway als lidl-flyer / /scrape-lidl.) Bevat Open-Food-Facts-verrijking.
// NB: de push-alert-stap (sendAlertNotifications) uit de Vercel-route is bewust NIET geport —
// Deal Alerts zijn in de UI uitgeschakeld (2026-04-29), dus geen subscribers; scheelt
// web-push + redis op Railway. Opnieuw nodig? Zie app/api/scrape commit-historie.
import { logScrape } from "../lib/logScrape.js";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

// ---- stableId (geïnlined uit app/lib/stableId.js) ----
function hash(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = Math.imul(31, h) + str.charCodeAt(i) | 0;
  return Math.abs(h).toString(36).slice(0, 7);
}
function stableId(store, name) {
  return `${store.toLowerCase().slice(0, 3)}-${hash(`${store}|${name}`)}`;
}

// ---- Datum-helpers ----
const _DAYS = ["zo", "ma", "di", "wo", "do", "vr", "za"];
const _MONTHS = ["januari", "februari", "maart", "april", "mei", "juni", "juli", "augustus", "september", "oktober", "november", "december"];
function dutchDate(daysFromNow = 7) {
  const d = new Date();
  d.setDate(d.getDate() + daysFromNow);
  return `${_DAYS[d.getDay()]} ${d.getDate()} ${_MONTHS[d.getMonth()]}`;
}
function toDutch(dateStr) {
  if (!dateStr) return dutchDate(7);
  let d;
  if (/^\d{4}-\d{2}-\d{2}/.test(dateStr)) d = new Date(dateStr.slice(0, 10));
  else if (/^\d{2}-\d{2}-\d{4}/.test(dateStr)) { const [day, month, year] = dateStr.split("-"); d = new Date(year, month - 1, day); }
  else if (/^\d{1,2}-\d{1,2}$/.test(dateStr)) {
    const [day, month] = dateStr.split("-").map(Number);
    const now = new Date(); let year = now.getFullYear();
    const candidate = new Date(year, month - 1, day);
    if (candidate < now && (now - candidate) > 180 * 86400000) year++;
    d = new Date(year, month - 1, day);
  } else return dutchDate(7);
  if (isNaN(d)) return dutchDate(7);
  return `${_DAYS[d.getDay()]} ${d.getDate()} ${_MONTHS[d.getMonth()]}`;
}
function tsToDate(ts) {
  const d = new Date(ts * 1000);
  if (isNaN(d)) return dutchDate(7);
  return `${_DAYS[d.getDay()]} ${d.getDate()} ${_MONTHS[d.getMonth()]}`;
}

const CATEGORY_EMOJI = {
  "dranken": "🥤", "zuivel": "🥛", "vlees": "🥩", "brood": "🍞", "bakkerij": "🥐",
  "vis": "🐟", "diepvries": "🧊", "groenten": "🥦", "fruit": "🍎", "koeken": "🍫",
  "chocolade": "🍫", "snoep": "🍬", "wijn": "🍷", "bier": "🍺", "hygiëne": "🧴",
  "baby": "🍼", "pasta": "🍝", "kaas": "🧀", "koffie": "☕", "snacks": "🍿",
  "aardappel": "🥔", "maaltijd": "🍲", "charcuterie": "🥓",
};
function categoryToEmoji(cat) {
  if (!cat) return "🛒";
  const lower = cat.toLowerCase();
  for (const [key, emoji] of Object.entries(CATEGORY_EMOJI)) if (lower.includes(key)) return emoji;
  return "🛒";
}

const HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
  "Accept-Language": "nl-BE,nl;q=0.9",
  "Accept": "text/html,application/json,*/*;q=0.8",
};

// ---- Supabase helpers ----
async function supabaseReadData(key) {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) return null;
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/cache?key=eq.${encodeURIComponent(key)}&select=data`, {
      headers: { apikey: SUPABASE_SERVICE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_KEY}` },
    });
    if (!res.ok) return null;
    const rows = await res.json();
    return rows?.[0]?.data ?? null;
  } catch { return null; }
}
async function supabaseReadIds(key) {
  const data = await supabaseReadData(key);
  if (!Array.isArray(data)) return new Set();
  return new Set(data.map(d => d.id).filter(Boolean));
}
async function supabaseWrite(key, data) {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) return;
  const res = await fetch(`${SUPABASE_URL}/rest/v1/cache`, {
    method: "POST",
    headers: {
      apikey: SUPABASE_SERVICE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
      "Content-Type": "application/json", Prefer: "resolution=merge-duplicates",
    },
    body: JSON.stringify({ key, data, updated_at: new Date().toISOString() }),
  });
  if (!res.ok) console.error(`supabaseWrite(${key}) failed: ${res.status}`);
}

// ---- Open Food Facts-verrijking ----
const OFF_MISS_CAP = 400;
async function enrichWithOFF(deals) {
  const needing = deals.filter(d => d.ean && !d.nutriscore);
  if (!needing.length || !SUPABASE_URL || !SUPABASE_SERVICE_KEY) return deals;

  let cache = (await supabaseReadData("off")) || {};
  const allMisses = [...new Set(needing.map(d => d.ean).filter(e => !(e in cache)))];
  const misses = allMisses.slice(0, OFF_MISS_CAP);
  if (allMisses.length > misses.length) console.log(`[off] ${allMisses.length} EANs, ${misses.length} deze run`);

  const CONC = 8;
  for (let i = 0; i < misses.length; i += CONC) {
    await Promise.all(misses.slice(i, i + CONC).map(async (ean) => {
      try {
        const r = await fetch(`https://world.openfoodfacts.org/api/v2/product/${ean}.json?fields=nutriscore_grade,brands`, {
          headers: { "User-Agent": "Dealoco/1.0 (hallo@dealoco.be)" }, signal: AbortSignal.timeout(8000),
        });
        const j = await r.json();
        const p = j?.status === 1 ? j.product : null;
        const entry = {};
        if (p && /^[a-e]$/.test(p.nutriscore_grade || "")) entry.n = p.nutriscore_grade;
        if (p?.brands) entry.b = String(p.brands).split(",")[0].trim();
        cache[ean] = entry;
      } catch { /* niet cachen */ }
    }));
  }
  try { await supabaseWrite("off", cache); } catch {}
  for (const d of deals) {
    const e = d.ean && cache[d.ean];
    if (e?.n && !d.nutriscore) d.nutriscore = e.n;
    if (e?.b && !d.brand) d.brand = e.b;
  }
  return deals;
}

// ---- Aldi ----
function aldiDeepFind(o, key) {
  if (o && typeof o === "object") {
    if (!Array.isArray(o) && key in o) return o[key];
    for (const v of Array.isArray(o) ? o : Object.values(o)) {
      const r = aldiDeepFind(v, key);
      if (r !== undefined) return r;
    }
  }
  return undefined;
}
function extractAldiMap(html) {
  const m = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (!m) throw new Error("Aldi: geen __NEXT_DATA__");
  const data = JSON.parse(m[1]);
  const apiRaw = data?.props?.pageProps?.apiData;
  if (!apiRaw) throw new Error("Aldi: geen apiData in __NEXT_DATA__");
  const inner = typeof apiRaw === "string" ? JSON.parse(apiRaw) : apiRaw;
  const map = aldiDeepFind(inner, "algoliaDataMap");
  if (!map || typeof map !== "object") throw new Error("Aldi: geen algoliaDataMap");
  return map;
}
async function fetchAldiMap(url) {
  const res = await fetch(url, { headers: HEADERS });
  if (!res.ok) throw new Error(`Aldi ${url} ${res.status}`);
  return extractAldiMap(await res.text());
}
function aldiSavingsFromPromo(t) {
  if (!t) return 0;
  const s = String(t).toLowerCase();
  let m = s.match(/2\s*(?:e|de)\s+aan\s*[-–—−]?\s*(\d{1,2})\s*%/);
  if (m) return Math.round(parseInt(m[1]) / 2);
  m = s.match(/(\d+)\s*\+\s*(\d+)\s*gratis/);
  if (m) { const b = +m[1], f = +m[2]; return b + f > 0 ? Math.round((f / (b + f)) * 100) : 0; }
  m = s.match(/[-–—−]\s*(\d{1,2})\s*%/);
  if (m) return parseInt(m[1]);
  return 0;
}
async function scrapeAldi() {
  const [nlMap, frMap] = await Promise.all([
    fetchAldiMap("https://www.aldi.be/aanbiedingen.html"),
    fetchAldiMap("https://www.aldi.be/fr/offres.html").catch(() => ({})),
  ]);
  const frNames = new Map();
  for (const [art, p] of Object.entries(frMap)) if (p?.name) frNames.set(art, p.name);

  const deals = [];
  for (const [art, p] of Object.entries(nlMap)) {
    const cp = p.currentPrice || {};
    const newPrice = typeof cp.priceValue === "number" ? cp.priceValue : 0;
    if (!(newPrice > 0)) continue;
    const strike = cp.strikePrice?.strikePriceValue;
    const originalPrice = (typeof strike === "number" && strike > newPrice) ? strike : newPrice;
    const promo = cp.priceTagLabels?.promoText1 || p.promotionPrices?.[0]?.priceTagLabels?.promoText1 || "";
    let savings = originalPrice > newPrice ? Math.round((1 - newPrice / originalPrice) * 100) : aldiSavingsFromPromo(promo);
    savings = Math.min(99, Math.max(0, savings));
    const lvl0 = Array.isArray(p.hierarchicalCategories?.lvl0) ? p.hierarchicalCategories.lvl0[0] : null;
    const category = lvl0 || "Overig";
    const primary = (p.assets || []).find(a => a.type === "primary") || (p.assets || [])[0];
    const iso = p.promotionPrices?.[0]?.validUntilLocalDate;
    const validUntil = iso ? toDutch(iso) : (cp.validUntil ? tsToDate(cp.validUntil) : dutchDate(7));
    deals.push({
      id: `aldi-${art}`, store: "Aldi", storeColor: "#1E5AA8", storeLogo: "AL",
      item: p.name || "Onbekend product",
      ...(frNames.has(art) && { item_fr: frNames.get(art) }),
      deal: promo || (savings > 0 ? `-${savings}%` : "Actieprijs"),
      category, originalPrice, newPrice, savings,
      emoji: categoryToEmoji(category), validUntil, hot: savings >= 30, image: primary?.url || null,
    });
  }
  if (deals.length === 0) throw new Error("Aldi: geen deals geparseerd");
  return deals;
}

// ---- Jumbo ----
async function scrapeJumbo() {
  const GQL_HEADERS = {
    ...HEADERS, "Content-Type": "application/json", "Accept": "application/json",
    "apollographql-client-name": "JUMBO_WEB", "apollographql-client-version": "master-v30.15.0-web",
  };
  const tabRes = await fetch("https://www.jumbo.com/api/graphql", {
    method: "POST", headers: GQL_HEADERS,
    body: JSON.stringify({
      query: `query promotionTab($id: String!) {
        promotionTab(id: $id) {
          runtimes { active end { iso }
            sections { title
              categories { title promotions { id title subtitle image start { iso } end { iso } tags { text } } }
              promotions { id title subtitle image start { iso } end { iso } tags { text } } } } } }`,
      variables: { id: "actieprijs" },
    }),
  });
  if (!tabRes.ok) throw new Error(`Jumbo tab ${tabRes.status}`);
  const tabJson = await tabRes.json();
  const runtimes = tabJson?.data?.promotionTab?.runtimes ?? [];
  const runtime = runtimes.find(r => r.active) ?? runtimes[0];
  if (!runtime) throw new Error("Jumbo: geen actieve runtime");

  const promos = [];
  for (const section of runtime.sections ?? []) {
    for (const p of section.promotions ?? []) promos.push({ ...p, category: section.title });
    for (const cat of section.categories ?? []) for (const p of cat.promotions ?? []) promos.push({ ...p, category: cat.title });
  }
  if (promos.length === 0) throw new Error("Jumbo: geen promoties");

  const today = new Date().toISOString().slice(0, 10);
  const details = await Promise.allSettled(promos.map(async (p) => {
    try {
      const r = await fetch("https://www.jumbo.com/api/graphql", {
        method: "POST", headers: GQL_HEADERS,
        body: JSON.stringify({
          query: `query promotion($id: String!, $referenceDate: String!) {
            promotion(id: $id) { products { title image ean price(referenceDate: $referenceDate) { price promoPrice } } } }`,
          variables: { id: p.id, referenceDate: today },
        }),
      });
      if (!r.ok) return [];
      const j = await r.json();
      return j?.data?.promotion?.products ?? [];
    } catch { return []; }
  }));

  const seen = new Set();
  const deals = [];
  promos.forEach((p, i) => {
    const products = details[i].status === "fulfilled" ? details[i].value : [];
    const tag = p.tags?.[0]?.text ?? "";
    const validUntil = p.end?.iso ? toDutch(p.end.iso.slice(0, 10)) : dutchDate(7);
    for (const product of products) {
      const rawPromo = product?.price?.promoPrice ? product.price.promoPrice / 100 : 0;
      const rawOriginal = product?.price?.price ? product.price.price / 100 : 0;
      if (!rawPromo && !rawOriginal) continue;
      let savings = rawOriginal > rawPromo && rawPromo > 0 ? Math.round((1 - rawPromo / rawOriginal) * 100) : 0;
      let originalPrice = rawOriginal || rawPromo;
      let newPrice = rawPromo || rawOriginal;
      let bundleInfo = null;
      if (savings === 0 && tag) {
        const unitPrice = rawOriginal || rawPromo;
        const bundleMatch = tag.match(/(\d+)\s*[+×x]\s*(\d+)\s*gratis/i);
        if (bundleMatch) {
          const buy = parseInt(bundleMatch[1]), free = parseInt(bundleMatch[2]);
          savings = Math.round(free / (buy + free) * 100);
          originalPrice = unitPrice;
          newPrice = parseFloat((unitPrice * buy / (buy + free)).toFixed(2));
          bundleInfo = { buy, free };
        }
        const voorMatch = tag.match(/(\d+)?\s*voor\s*€?\s*(\d+(?:[,.]\d+)?)/i);
        if (voorMatch && !bundleMatch) {
          const qty = voorMatch[1] ? parseInt(voorMatch[1]) : 1;
          const perItem = parseFloat(voorMatch[2].replace(",", ".")) / qty;
          if (perItem > 0 && rawOriginal > perItem) {
            savings = Math.round((1 - perItem / rawOriginal) * 100);
            newPrice = +perItem.toFixed(2); originalPrice = rawOriginal;
          }
        }
        const halvePrijsMatch = tag.match(/2(?:e|de)\s+halve\s+prijs/i);
        const aanPctMatch = tag.match(/2(?:e|de)\s+(?:aan|tegen)\s*[-–]?\s*(\d+)\s*%/i);
        if ((halvePrijsMatch || aanPctMatch) && !bundleMatch) {
          const pct = aanPctMatch ? parseInt(aanPctMatch[1]) : 50;
          if (unitPrice > 0) {
            savings = Math.round(pct / 2);
            originalPrice = unitPrice;
            newPrice = parseFloat((unitPrice * (2 - pct / 100) / 2).toFixed(2));
          }
        }
      }
      const name = product?.title || p.title || p.subtitle || "Onbekend";
      const id = stableId("Jumbo", name);
      if (seen.has(id)) continue;
      seen.add(id);
      deals.push({
        id, store: "Jumbo", storeColor: "#FFD700", storeLogo: "J", item: name,
        deal: tag || (savings > 0 ? `-${savings}%` : "Actieprijs"),
        category: p.category || "Overig", originalPrice, newPrice, savings,
        emoji: categoryToEmoji(p.category), validUntil, hot: savings >= 30,
        image: product?.image || p.image || null,
        ...(product?.ean && { ean: String(product.ean) }),
        ...(bundleInfo && { bundleBuy: bundleInfo.buy, bundleFree: bundleInfo.free }),
      });
    }
  });
  return await enrichWithOFF(deals);
}

// ---- Hoofd-functie ----
export async function scrapeDeals() {
  const timed = async (fn) => {
    const t = Date.now();
    try { return { deals: await fn(), error: null, durationMs: Date.now() - t }; }
    catch (err) { return { deals: [], error: err.message ?? "unknown", durationMs: Date.now() - t }; }
  };

  const [aldiR, jumboR] = await Promise.all([timed(scrapeAldi), timed(scrapeJumbo)]);
  const errors = {};
  if (aldiR.error) errors.Aldi = aldiR.error;
  if (jumboR.error) errors.Jumbo = jumboR.error;

  let deals = [...aldiR.deals, ...jumboR.deals];

  // Partial failure: behoud bestaande deals van falende scrapers
  if (deals.length > 0 && (aldiR.error || jumboR.error)) {
    try {
      const existing = await supabaseReadData("deals");
      if (Array.isArray(existing)) {
        const failedStores = new Set();
        if (aldiR.error) failedStores.add("Aldi");
        if (jumboR.error) failedStores.add("Jumbo");
        deals = [...deals, ...existing.filter(d => failedStores.has(d.store))];
      }
    } catch {}
  }

  if (deals.length > 0) await supabaseWrite("deals", deals);

  await Promise.allSettled([
    logScrape({ source: "Aldi", dealCount: aldiR.deals.length, errors: aldiR.error ? [aldiR.error] : [], durationMs: aldiR.durationMs }),
    logScrape({ source: "Jumbo", dealCount: jumboR.deals.length, errors: jumboR.error ? [jumboR.error] : [], durationMs: jumboR.durationMs }),
  ]).catch(err => console.error("[deals] logScrape failed:", err));

  const counts = { Aldi: aldiR.deals.length, Jumbo: jumboR.deals.length, total: deals.length };
  console.log("[deals]", { counts, errors, at: new Date().toISOString() });
  return { ok: true, counts, errors };
}
