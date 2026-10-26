// Delhaize scraper — GQL via Brightdata residential proxy (Cloudflare blokkeert Vercel IPs)
import { ProxyAgent, fetch as undiciFetch } from "undici";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const BD_HOST = process.env.BRIGHTDATA_HOST;
const BD_USER = process.env.BRIGHTDATA_USER;
const BD_PASS = process.env.BRIGHTDATA_PASS;
const USE_PROXY = !!(BD_HOST && BD_USER && BD_PASS);

const proxyUrl = USE_PROXY
  ? `http://${BD_USER}:${BD_PASS}@${BD_HOST.includes(":") ? BD_HOST : BD_HOST + ":22225"}`
  : null;
const proxyDispatcher = proxyUrl ? new ProxyAgent({
  uri: proxyUrl,
  requestTls: { rejectUnauthorized: false },
  proxyTls: { rejectUnauthorized: false },
}) : null;

const _DAYS = ["zo", "ma", "di", "wo", "do", "vr", "za"];
const _MONTHS = ["januari", "februari", "maart", "april", "mei", "juni",
  "juli", "augustus", "september", "oktober", "november", "december"];

function dutchDate(daysFromNow = 7) {
  const d = new Date();
  d.setDate(d.getDate() + daysFromNow);
  return `${_DAYS[d.getDay()]} ${d.getDate()} ${_MONTHS[d.getMonth()]}`;
}

function toDutch(dateStr) {
  if (!dateStr) return dutchDate(7);
  let d;
  if (/^\d{4}-\d{2}-\d{2}/.test(dateStr)) {
    d = new Date(dateStr.slice(0, 10));
  } else if (/^\d{2}-\d{2}-\d{4}/.test(dateStr)) {
    const [day, month, year] = dateStr.split("-");
    d = new Date(year, month - 1, day);
  } else {
    return dutchDate(7);
  }
  if (isNaN(d)) return dutchDate(7);
  return `${_DAYS[d.getDay()]} ${d.getDate()} ${_MONTHS[d.getMonth()]}`;
}

// Identiek aan app/lib/stableId.js
function stableIdHash(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(31, h) + str.charCodeAt(i) | 0;
  }
  return Math.abs(h).toString(36).slice(0, 7);
}
function stableId(store, name) {
  return `${store.toLowerCase().slice(0, 3)}-${stableIdHash(`${store}|${name}`)}`;
}

function _categorize(name, categories) {
  const cat = Array.isArray(categories) ? (categories[0]?.name || "") : "";
  return cat || "Overig";
}

const CATEGORY_EMOJI = {
  "dranken": "🥤", "zuivel": "🥛", "vlees": "🥩", "brood": "🍞",
  "bakkerij": "🥐", "vis": "🐟", "diepvries": "🧊", "groenten": "🥦",
  "fruit": "🍎", "koeken": "🍫", "chocolade": "🍫", "snoep": "🍬",
  "wijn": "🍷", "bier": "🍺", "hygiëne": "🧴", "baby": "🍼",
  "pasta": "🍝", "kaas": "🧀", "koffie": "☕", "snacks": "🍿",
  "aardappel": "🥔", "maaltijd": "🍲", "charcuterie": "🥓",
};
function categoryToEmoji(cat) {
  if (!cat) return "🛒";
  const lower = cat.toLowerCase();
  for (const [key, emoji] of Object.entries(CATEGORY_EMOJI)) {
    if (lower.includes(key)) return emoji;
  }
  return "🛒";
}

function parseDelhaizePromo(desc, promoPrice) {
  if (!desc) return { savings: 0, originalPrice: promoPrice };
  const s = desc.toLowerCase();

  const tweedeAanMatch = desc.match(/2(?:e|de)\s+(?:aan|tegen)\s*[-–]?\s*(\d+)\s*%/i);
  if (tweedeAanMatch) {
    const pct = parseInt(tweedeAanMatch[1]);
    return { savings: Math.round(pct / 2), originalPrice: promoPrice };
  }
  if (/2(?:e|de)\s+halve\s+prijs/i.test(s)) {
    return { savings: 25, originalPrice: promoPrice };
  }

  const pctMatch = desc.match(/(\d+)\s*%/);
  if (pctMatch) {
    const pct = parseInt(pctMatch[1]);
    if (pct > 0 && pct < 100) {
      const original = promoPrice > 0 ? parseFloat((promoPrice / (1 - pct / 100)).toFixed(2)) : promoPrice;
      return { savings: pct, originalPrice: original };
    }
  }

  if (s.includes("halve prijs") || s.includes("half price")) {
    return { savings: 50, originalPrice: parseFloat((promoPrice * 2).toFixed(2)) };
  }

  const bundleMatch = desc.match(/(\d+)\s*\+\s*(\d+)\s*gratis/i);
  if (bundleMatch) {
    const buy = parseInt(bundleMatch[1]);
    const free = parseInt(bundleMatch[2]);
    const pct = Math.round(free / (buy + free) * 100);
    return {
      savings: pct,
      originalPrice: parseFloat(((buy + free) * promoPrice).toFixed(2)),
      newPrice: parseFloat((buy * promoPrice).toFixed(2)),
      bundleBuy: buy, bundleFree: free,
    };
  }

  return { savings: 0, originalPrice: promoPrice, newPrice: null, bundleBuy: null, bundleFree: null };
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
    body: JSON.stringify({ key: "delhaize", data: deals, updated_at: new Date().toISOString() }),
  });
  if (!res.ok) throw new Error(`Supabase write failed: ${res.status} ${await res.text()}`);
}

const QUERIES_NL = [
  "vlees", "vis", "kip", "zalm", "ham", "worst", "gehakt", "steak",
  "zuivel", "kaas", "yoghurt", "melk", "boter", "eieren", "room",
  "brood", "bakkerij", "croissant",
  "groenten", "fruit", "aardappel", "salade", "tomaat", "appel", "banaan",
  "dranken", "bier", "wijn", "cola", "sap", "water", "koffie", "thee",
  "diepvries", "pizza", "ijs", "friet",
  "pasta", "rijst", "soep", "saus", "conserven", "olie",
  "snacks", "chips", "koeken", "chocolade", "snoep", "noten",
  "hygiëne", "shampoo", "tandpasta", "deo", "zeep", "luier", "baby",
  "huishouden", "wasmiddel", "afwasmiddel", "papier", "schoonmaak",
  "charcuterie", "salami",
  "ontbijt", "muesli", "cornflakes", "confituur", "honing",
  "maaltijd", "traiteur",
];
const QUERIES_FR = [
  "viande", "poisson", "poulet", "saumon", "jambon", "saucisse", "hache", "steak",
  "produits laitiers", "fromage", "yaourt", "lait", "beurre", "oeufs", "creme",
  "pain", "boulangerie", "croissant",
  "legumes", "fruits", "pommes de terre", "salade", "tomate", "pomme", "banane",
  "boissons", "biere", "vin", "cola", "jus", "eau", "cafe", "the",
  "surgeles", "pizza", "glace", "frites",
  "pates", "riz", "soupe", "sauce", "conserves", "huile",
  "snacks", "chips", "biscuits", "chocolat", "bonbons", "noix",
  "hygiene", "shampooing", "dentifrice", "deodorant", "savon", "couche", "bebe",
  "menage", "lessive", "liquide vaisselle", "papier", "nettoyant",
  "charcuterie", "salami",
  "petit-dejeuner", "muesli", "cereales", "confiture", "miel",
  "repas", "traiteur",
];

const GQL = `query Search($lang: String, $q: String, $size: Int, $page: Int) {
  productSearch: productSearchV2(lang: $lang searchQuery: $q pageSize: $size pageNumber: $page) {
    products {
      name
      price { value }
      images { url }
      categories { name }
      badges { code }
      potentialPromotions { description endDate }
    }
  }
}`;

const FETCH_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
  "Accept-Language": "nl-BE,nl;q=0.9",
  "Content-Type": "application/json",
  "Accept": "application/json",
  "Origin": "https://www.delhaize.be",
  "Referer": "https://www.delhaize.be/nl/in-promo",
};

const BATCH_SIZE = 5;

async function fetchDelhaizeProducts(lang) {
  const results = [];
  const queries = lang === "fr" ? QUERIES_FR : QUERIES_NL;
  const headers = {
    ...FETCH_HEADERS,
    "Accept-Language": lang === "fr" ? "fr-BE,fr;q=0.9" : "nl-BE,nl;q=0.9",
    "Referer": lang === "fr" ? "https://www.delhaize.be/fr/en-promo" : "https://www.delhaize.be/nl/in-promo",
  };
  for (let i = 0; i < queries.length; i += BATCH_SIZE) {
    const batch = queries.slice(i, i + BATCH_SIZE);
    const batchResults = await Promise.all(batch.map(async (q) => {
      const allProducts = [];
      for (let page = 0; page < 2; page++) {
        try {
          const res = await undiciFetch("https://www.delhaize.be/api/v1/", {
            method: "POST",
            headers,
            body: JSON.stringify({
              operationName: "Search",
              query: GQL,
              variables: { lang, q, size: 40, page },
            }),
            ...(proxyDispatcher ? { dispatcher: proxyDispatcher } : {}),
          });
          if (!res.ok) break;
          const json = await res.json();
          const prods = (json?.data?.productSearch?.products || [])
            .filter(p => Array.isArray(p.potentialPromotions) && p.potentialPromotions.length > 0);
          allProducts.push(...prods);
          if ((json?.data?.productSearch?.products || []).length < 40) break;
        } catch { break; }
      }
      return allProducts;
    }));
    results.push(...batchResults.flat());
  }
  return results;
}

export async function scrapeDelhaize() {
  // Fetch NL and FR in parallel
  const [nlResults, frResults] = await Promise.all([
    fetchDelhaizeProducts("nl"),
    fetchDelhaizeProducts("fr").catch(err => { console.log(`[delhaize] FR fetch fout: ${err.message}`); return []; }),
  ]);

  // Dedupliceer NL op naam
  const seen = new Set();
  const unique = nlResults.filter(p => {
    if (seen.has(p.name)) return false;
    seen.add(p.name);
    return true;
  });

  // Build FR name lookup by image URL + composite key (price|image)
  const frByImage = new Map();
  const frByComposite = new Map();
  for (const p of frResults) {
    const imgUrl = Array.isArray(p.images) ? p.images[0]?.url : null;
    if (imgUrl && p.name) frByImage.set(imgUrl, p.name);
    if (p.price?.value && imgUrl && p.name) frByComposite.set(`${p.price.value}|${imgUrl}`, p.name);
  }
  console.log(`[delhaize] FR namen: ${frByImage.size} by image, ${frByComposite.size} by composite`);

  const deals = unique.map((p, i) => {
    const price = p.price?.value ?? 0;
    const promo = p.potentialPromotions[0];
    const { savings, originalPrice, newPrice: bundleNewPrice, bundleBuy, bundleFree } = parseDelhaizePromo(promo.description, price);
    const imgUrl = Array.isArray(p.images) ? p.images[0]?.url : null;
    const cat = Array.isArray(p.categories) ? (p.categories[0]?.name || "Overig") : "Overig";
    // Prefer composite key (more specific), fallback to image-only
    const frName = (price && imgUrl ? frByComposite.get(`${price}|${imgUrl}`) : undefined) || (imgUrl ? frByImage.get(imgUrl) : undefined);

    return {
      id: stableId("Delhaize", p.name || String(i)),
      store: "Delhaize", storeColor: "#E4002B", storeLogo: "D",
      emoji: categoryToEmoji(cat),
      item: p.name || "Onbekend",
      ...(frName && { item_fr: frName }),
      deal: promo.description || "Promo",
      category: cat,
      originalPrice,
      newPrice: bundleNewPrice ?? price,
      ...(bundleBuy && { bundleBuy, bundleFree }),
      savings,
      validUntil: promo.endDate ? toDutch(promo.endDate) : dutchDate(7),
      hot: savings >= 30,
      image: imgUrl ? (imgUrl.startsWith("http") ? imgUrl : `https://www.delhaize.be${imgUrl}`) : null,
      ...(Array.isArray(p.badges) && p.badges.some(b => b?.code === "badgeproductisbio") && { bio: true }),
    };
  });

  console.log(`[delhaize] ${deals.length} unieke deals`);

  if (deals.length > 0) {
    await supabaseWrite(deals);
  }

  return { total: deals.length };
}
