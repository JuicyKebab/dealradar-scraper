import { parse as parseHtml } from "node-html-parser";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

// slagersonline.be draait op hetzelfde platform als bakkersonline.be (Localtomorrow NV).
// Verschil: slagers exposen een vaste weekpromo-route i.p.v. promo-categorieen.
const BASE = "https://slagersonline.be/be-nl";
const HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
  "Accept": "application/json",
  "Accept-Language": "nl-BE,nl;q=0.9",
  "X-Requested-With": "XMLHttpRequest",
};

const BATCH_SIZE = 15;

const _DAYS = ["zo", "ma", "di", "wo", "do", "vr", "za"];
const _MONTHS = ["januari", "februari", "maart", "april", "mei", "juni",
  "juli", "augustus", "september", "oktober", "november", "december"];

function dutchDate(daysFromNow = 7) {
  const d = new Date();
  d.setDate(d.getDate() + daysFromNow);
  return `${_DAYS[d.getDay()]} ${d.getDate()} ${_MONTHS[d.getMonth()]}`;
}

// Bundeldeal uit productnaam (identiek aan bakkersonline): "5+1 gratis", "2e halve prijs", ...
function parseBundleName(name) {
  const gratis = name.match(/^(\d+)\s*\+\s*(\d+)\s+(.+?)\s+gratis$/i);
  if (gratis) {
    const buy = parseInt(gratis[1]);
    const free = parseInt(gratis[2]);
    const item = gratis[3].trim();
    const itemName = item.charAt(0).toUpperCase() + item.slice(1);
    const savings = Math.round(free / (buy + free) * 100);
    return { buy, free, item: itemName, deal: `${buy}+${free} gratis`, savings };
  }
  const bundle = name.match(/(\d+)\s*\+\s*(\d+)/);
  if (bundle) {
    const buy = parseInt(bundle[1]);
    const free = parseInt(bundle[2]);
    const savings = Math.round(free / (buy + free) * 100);
    return { buy, free, item: name, deal: `${buy}+${free}`, savings };
  }
  if (/2e\s+halve\s+prijs|tweede\s+halve\s+prijs/i.test(name)) {
    return { buy: 2, free: 0, item: name, deal: "2e halve prijs", savings: 25 };
  }
  // "-15%" / "-15 %" in de naam
  const pct = name.match(/-\s*(\d{1,2})\s*%/);
  if (pct) {
    const savings = parseInt(pct[1]);
    return { buy: 1, free: 0, item: name, deal: `-${savings}%`, savings };
  }
  return null;
}

// slagersonline geeft JSON aan het einde van een HTML-response: {"html": "..."}
async function fetchJson(url) {
  const res = await fetch(url, { headers: HEADERS });
  if (!res.ok) return null;
  const text = await res.text();
  try { return JSON.parse(text); } catch {}
  const jsonMatch = text.match(/\{"html":.*\}$/s);
  if (jsonMatch) {
    try { return JSON.parse(jsonMatch[0]); } catch { return null; }
  }
  return null;
}

// Alle slagers met adres + slug
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

// Scrape de vaste weekpromo-pagina van een slager
async function scrapeShopPromos(shop) {
  const data = await fetchJson(`${BASE}/${shop.slug}/offers/weekpromo`);
  if (!data?.html) return [];
  const root = parseHtml(data.html);
  const deals = [];

  for (const article of root.querySelectorAll("article[data-tms-product-id]")) {
    const productId = article.getAttribute("data-tms-product-id");
    const productName = article.getAttribute("data-tms-product-name") || "";
    const priceStr = article.getAttribute("data-tms-product-price") || "0";
    const price = parseFloat(priceStr) || 0;
    if (!productName || !productId) continue;

    const img = article.querySelector("img")?.getAttribute("src")
      || article.querySelector("img")?.getAttribute("data-src") || null;

    const bundle = parseBundleName(productName);

    deals.push({
      id: `slagersonline-${shop.id}-${productId}`,
      store: shop.name,
      // Canonieke waarden schrijven (matcht de "Slagerij"-groep in STORE_COORDS + de valid
      // CATEGORIES-waarde), zodat de raw cache == de /api/deals-lijst == de detailpagina
      // (findDealById leest de raw cache en past de read-time overrides NIET toe). "Slagerij"
      // is een winkel/groep, GEEN productcategorie -> categorie is "Vlees & Vis".
      storeColor: "#8B0000",
      storeLogo: "SL",
      storeLat: shop.lat,
      storeLon: shop.lon,
      storeCity: shop.city,
      storeAddress: [shop.street, shop.city].filter(Boolean).join(", "),
      item: productName,
      deal: bundle ? bundle.deal : "Weekpromo",
      category: "Vlees & Vis",
      originalPrice: 0,
      newPrice: price,
      savings: bundle ? bundle.savings : 0,
      bundleBuy: bundle?.buy ?? null,
      bundleFree: bundle?.free ?? null,
      emoji: "🥩",
      validUntil: dutchDate(7),
      hot: bundle ? bundle.savings >= 25 : false,
      image: img,
      // Link naar de JUISTE plek op de website: de weekpromo-pagina van deze slager
      shopSlug: shop.slug,
      dealUrl: `${BASE}/${shop.slug}/offers/weekpromo`,
      productUrl: `${BASE}/${shop.slug}/product/${productId}`,
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
    body: JSON.stringify({ key: "slagersonline", data: deals, updated_at: new Date().toISOString() }),
  });
  if (!res.ok) throw new Error(`Supabase write failed: ${res.status} ${await res.text()}`);
}

export async function scrapeAllSlagersonline() {
  const shops = await getAllShops();
  console.log(`[Slagersonline] ${shops.length} shops found`);

  const allDeals = [];
  const shopsWithPromosSet = new Set();

  for (let i = 0; i < shops.length; i += BATCH_SIZE) {
    const batch = shops.slice(i, i + BATCH_SIZE);
    const results = await Promise.allSettled(batch.map(s => scrapeShopPromos(s)));
    for (let j = 0; j < batch.length; j++) {
      const r = results[j];
      const shop = batch[j];
      if (r.status === "fulfilled" && r.value.length > 0) {
        allDeals.push(...r.value);
        shopsWithPromosSet.add(shop.id);
        console.log(`[Slagersonline] ${shop.name} (${shop.city}): ${r.value.length} promo deals`);
      } else if (r.status === "rejected") {
        console.error(`[Slagersonline] ${shop.name} ERROR:`, r.reason?.message);
      }
    }
  }

  // Dedup op id
  const seen = new Set();
  const unique = allDeals.filter(d => {
    if (seen.has(d.id)) return false;
    seen.add(d.id);
    return true;
  });

  const shopsWithPromos = shopsWithPromosSet.size;
  console.log(`[Slagersonline] Done: ${unique.length} deals from ${shopsWithPromos} butchers`);

  if (unique.length > 0) {
    await supabaseWrite(unique);
    console.log(`[Slagersonline] Wrote ${unique.length} deals to Supabase`);
  } else {
    console.warn("[Slagersonline] No promo deals found");
  }

  return { total: unique.length, shopsWithPromos };
}
