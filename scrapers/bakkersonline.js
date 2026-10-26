import { parse as parseHtml } from "node-html-parser";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const BASE = "https://bakkersonline.be/be-nl";
const HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
  "Accept": "application/json",
  "Accept-Language": "nl-BE,nl;q=0.9",
  "X-Requested-With": "XMLHttpRequest",
};

const BATCH_SIZE = 20;

const _DAYS = ["zo", "ma", "di", "wo", "do", "vr", "za"];
const _MONTHS = ["januari", "februari", "maart", "april", "mei", "juni",
  "juli", "augustus", "september", "oktober", "november", "december"];

function dutchDate(daysFromNow = 7) {
  const d = new Date();
  d.setDate(d.getDate() + daysFromNow);
  return `${_DAYS[d.getDay()]} ${d.getDate()} ${_MONTHS[d.getMonth()]}`;
}

function parseEndDate(text) {
  if (!text) return dutchDate(14);
  const t = text.toLowerCase().trim();
  const named = t.match(/(\d{1,2})\s+(januari|februari|maart|april|mei|juni|juli|augustus|september|oktober|november|december)/);
  if (named) {
    const day = parseInt(named[1]);
    const m = _MONTHS.indexOf(named[2]);
    const now = new Date();
    const d = new Date(now.getFullYear(), m, day);
    if (d < now && (now - d) > 30 * 86400000) d.setFullYear(now.getFullYear() + 1);
    return `${_DAYS[d.getDay()]} ${day} ${_MONTHS[m]}`;
  }
  return dutchDate(14);
}

// Parse bundle deal from product name.
// Handles:
//   "3+1 donut gratis"  → buy 3 get 1 free
//   "Pakket 1+1 PROMO"  → buy 1 get 1 (inferred free)
//   "2e halve prijs"    → buy 2 second half price (~25% savings)
function parseBundleName(name) {
  // Exacte match: "X+Y item gratis" aan het einde
  const gratis = name.match(/^(\d+)\s*\+\s*(\d+)\s+(.+?)\s+gratis$/i);
  if (gratis) {
    const buy = parseInt(gratis[1]);
    const free = parseInt(gratis[2]);
    const item = gratis[3].trim();
    const itemName = item.charAt(0).toUpperCase() + item.slice(1);
    const savings = Math.round(free / (buy + free) * 100);
    return { buy, free, item: itemName, deal: `${buy}+${free} gratis`, savings };
  }
  // X+Y patroon ergens in de naam (bv. "Pakket mix 1+1 PROMO")
  const bundle = name.match(/(\d+)\s*\+\s*(\d+)/);
  if (bundle) {
    const buy = parseInt(bundle[1]);
    const free = parseInt(bundle[2]);
    const savings = Math.round(free / (buy + free) * 100);
    return { buy, free, item: name, deal: `${buy}+${free}`, savings };
  }
  // "2e halve prijs" / "tweede halve prijs"
  if (/2e\s+halve\s+prijs|tweede\s+halve\s+prijs/i.test(name)) {
    return { buy: 2, free: 0, item: name, deal: "2e halve prijs", savings: 25 };
  }
  return null;
}

// Fetch JSON response from bakkersonline (returns {html, ...} or HTML page)
async function fetchJson(url) {
  const res = await fetch(url, { headers: HEADERS });
  if (!res.ok) return null;
  const text = await res.text();
  // bakkersonline returns JSON embedded at end of HTML response
  const jsonMatch = text.match(/\{"html":.*\}$/s);
  if (jsonMatch) {
    try { return JSON.parse(jsonMatch[0]); } catch { return null; }
  }
  return null;
}

// Get all shops with their address and slug
async function getAllShops() {
  const res = await fetch(`${BASE}/data/shops`, { headers: HEADERS });
  if (!res.ok) throw new Error(`data/shops failed: ${res.status}`);
  const data = await res.json();
  const shops = [];
  for (const cat of Object.values(data.categories || {})) {
    for (const shop of cat.shops || []) {
      shops.push({
        id: shop.id,
        name: shop.name,
        slug: shop.url,
        lat: parseFloat(shop.address?.latitude) || 0,
        lon: parseFloat(shop.address?.longitude) || 0,
        city: shop.address?.city || "",
        street: `${shop.address?.street || ""} ${shop.address?.nr || ""}`.trim(),
      });
    }
  }
  return shops.filter(s => s.slug && s.lat && s.lon);
}

// Categorieën die wijzen op een echte promotie.
// Bewust NIET: "special/specialiteit" (te breed), seizoensgebonden eenmalige events (moederdag, etc.)
const PROMO_RE = /promo|aanbieding|actie|solde|keek|verloren|week\s+van|dagdeal|korting|\d\s*\+\s*\d/i;

// Get promo categories for a shop
async function getPromoCategories(shop) {
  const data = await fetchJson(`${BASE}/${shop.slug}/categories`);
  if (!data?.html) return [];
  const root = parseHtml(data.html);
  const promos = [];
  for (const article of root.querySelectorAll("article")) {
    const onclick = article.getAttribute("v-on:click") || "";
    const m = onclick.match(/loadView\('category',\s*(\d+),\s*'([^']+)'\)/);
    if (!m) continue;
    const [, catId, path] = m;
    const slug = path.split("/").pop() || "";
    const name = article.querySelector("h1")?.text?.trim() || slug;
    if (PROMO_RE.test(slug) || PROMO_RE.test(name)) {
      promos.push({ id: catId, slug, name, path });
    }
  }
  return promos;
}

// Scrape products from a promo category
async function scrapePromoCategory(shop, cat) {
  const data = await fetchJson(`${BASE}${cat.path}`);
  if (!data?.html) return [];
  const root = parseHtml(data.html);
  const deals = [];

  // Gebruik categorienaam als deal-label — strip uitroeptekens en datumstaarten zoals "12 jan 2026"
  const catLabel = cat.name
    .replace(/!+/g, "")
    .replace(/\s+\d{1,2}\s+(jan|feb|maa|apr|mei|jun|jul|aug|sep|okt|nov|dec)[^\s]*/gi, "")
    .replace(/\s+\d{4}$/, "")
    .trim();

  for (const article of root.querySelectorAll("article[data-tms-product-id]")) {
    const productId = article.getAttribute("data-tms-product-id");
    const productName = article.getAttribute("data-tms-product-name") || "";
    const priceStr = article.getAttribute("data-tms-product-price") || "0";
    const price = parseFloat(priceStr) || 0;

    if (!productName || !productId) continue;

    // Availability dates
    const availText = article.querySelector(".availability-info")?.text || "";
    const endMatch = availText.match(/tot\s+([^\n<]+)/i);
    const rawEndDate = endMatch?.[1]?.trim() || "";
    const validUntil = parseEndDate(rawEndDate) || dutchDate(14);

    // Image
    const img = article.querySelector("img")?.getAttribute("src")
      || article.querySelector("img")?.getAttribute("data-src") || null;

    // Bundle detectie: eerst in productnaam, dan in categorienaam
    const bundle = parseBundleName(productName) || parseBundleName(catLabel);

    deals.push({
      id: `bakkersonline-${shop.id}-${productId}`,
      store: shop.name,
      storeColor: "#D4763B",
      storeLogo: shop.name.charAt(0).toUpperCase(),
      storeLat: shop.lat,
      storeLon: shop.lon,
      storeCity: shop.city,
      storeAddress: [shop.street, shop.city].filter(Boolean).join(", "),
      item: productName,
      deal: bundle ? bundle.deal : catLabel,
      category: "Bakkerij",
      originalPrice: 0,
      newPrice: price,
      savings: bundle ? bundle.savings : 0,
      bundleBuy: bundle?.buy ?? null,
      bundleFree: bundle?.free ?? null,
      emoji: "🥐",
      validUntil,
      hot: bundle ? bundle.savings >= 25 : false,
      image: img,
      bakerySlug: shop.slug,
    });
  }
  return deals;
}

async function supabaseWrite(deals) {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    throw new Error("Supabase env vars missing");
  }
  const res = await fetch(`${SUPABASE_URL}/rest/v1/cache`, {
    method: "POST",
    headers: {
      apikey: SUPABASE_SERVICE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
      "Content-Type": "application/json",
      Prefer: "resolution=merge-duplicates",
    },
    body: JSON.stringify({ key: "bakkersonline", data: deals, updated_at: new Date().toISOString() }),
  });
  if (!res.ok) throw new Error(`Supabase write failed: ${res.status} ${await res.text()}`);
}

export async function scrapeAllBakkersonline() {
  const shops = await getAllShops();
  console.log(`[Bakkersonline] ${shops.length} shops found`);

  const allDeals = [];
  const shopsWithPromosSet = new Set();

  // Batch: fetch categories for all shops
  for (let i = 0; i < shops.length; i += BATCH_SIZE) {
    const batch = shops.slice(i, i + BATCH_SIZE);
    const catResults = await Promise.allSettled(batch.map(s => getPromoCategories(s)));

    // For shops with promo categories, fetch products
    const productFetches = [];
    for (let j = 0; j < batch.length; j++) {
      const shop = batch[j];
      const cats = catResults[j].status === "fulfilled" ? catResults[j].value : [];
      for (const cat of cats) {
        productFetches.push({ shop, cat });
      }
    }

    if (productFetches.length > 0) {
      const productResults = await Promise.allSettled(
        productFetches.map(({ shop, cat }) => scrapePromoCategory(shop, cat))
      );
      for (let k = 0; k < productFetches.length; k++) {
        const r = productResults[k];
        const { shop, cat } = productFetches[k];
        if (r.status === "fulfilled" && r.value.length > 0) {
          allDeals.push(...r.value);
          shopsWithPromosSet.add(shop.id);
          console.log(`[Bakkersonline] ${shop.name}: ${r.value.length} promo deals (${cat.name})`);
        } else if (r.status === "rejected") {
          console.error(`[Bakkersonline] ${shop.name} / ${cat.name} ERROR:`, r.reason?.message);
        }
      }
    }
  }

  // Deduplicate by id
  const seen = new Set();
  const unique = allDeals.filter(d => {
    if (seen.has(d.id)) return false;
    seen.add(d.id);
    return true;
  });

  const shopsWithPromos = shopsWithPromosSet.size;
  console.log(`[Bakkersonline] Done: ${unique.length} deals from ${shopsWithPromos} bakeries`);

  if (unique.length > 0) {
    await supabaseWrite(unique);
    console.log(`[Bakkersonline] Wrote ${unique.length} deals to Supabase`);
  } else {
    console.warn("[Bakkersonline] No promo deals found");
  }

  return { total: unique.length, shopsWithPromos };
}
