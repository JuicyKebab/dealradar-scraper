// Aldi Belgium — pure HTTP scraper (lazy-tile architecture)
// Haalt de main promotions page op, verzamelt alle data-tile-url's,
// fetcht elke tile parallel en parseert data-article JSON.
const https = require("https");

const _DDAYS = ["zo", "ma", "di", "wo", "do", "vr", "za"];
const _DMONTHS = ["januari", "februari", "maart", "april", "mei", "juni", "juli", "augustus", "september", "oktober", "november", "december"];

function dutchDate(daysFromNow = 7) {
  const d = new Date();
  d.setDate(d.getDate() + daysFromNow);
  return `${_DDAYS[d.getDay()]} ${d.getDate()} ${_DMONTHS[d.getMonth()]}`;
}

function tsDutch(ts) {
  // Aldi promotionDate is de startdatum; we tonen startdatum + 6 dagen als einddatum
  if (!ts) return dutchDate(7);
  const d = new Date(ts + 6 * 24 * 60 * 60 * 1000);
  return `${_DDAYS[d.getDay()]} ${d.getDate()} ${_DMONTHS[d.getMonth()]}`;
}

function categoryToEmoji(cat) {
  if (!cat) return "🛒";
  const lower = cat.toLowerCase();
  const map = {
    "wijn": "🍷", "bier": "🍺", "drank": "🥤", "zuivel": "🥛", "vlees": "🥩",
    "brood": "🍞", "diepvries": "🧊", "groenten": "🥦", "fruit": "🍎",
    "koeken": "🍫", "chocolade": "🍫", "snack": "🍿", "kaas": "🧀",
    "charcuterie": "🥓", "hygiëne": "🧴", "pasta": "🍝", "koffie": "☕",
  };
  for (const [key, emoji] of Object.entries(map)) { if (lower.includes(key)) return emoji; }
  return "🛒";
}

const HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
  "Accept-Language": "nl-BE,nl;q=0.9",
};

function httpGet(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: HEADERS }, res => {
      let d = "";
      res.on("data", c => d += c);
      res.on("end", () => resolve(d));
    }).on("error", reject);
  });
}

function parseTile(html) {
  const m = html.match(/data-article="([^"]+)"/);
  if (!m) return null;
  try {
    const data = JSON.parse(m[1].replace(/&#34;/g, "\""));
    const info = data.productInfo || data;
    const name = info.productName || info.name;
    if (!name || name.length < 2) return null;
    const price = parseFloat(info.priceWithTax) || parseFloat(info.price) || 0;
    const cat = data.productCategory?.primaryCategory || "";
    const ts = info.promotionDate || null;

    // Image: first srcset entry
    const imgMatch = html.match(/data-srcset="([^"]+)"/);
    let image = null;
    if (imgMatch) {
      const firstEntry = imgMatch[1].split(",")[0].trim().split(" ")[0];
      image = firstEntry.startsWith("http") ? firstEntry : `https://www.aldi.be${firstEntry}`;
    }

    return { name, price, cat, ts, image };
  } catch {
    return null;
  }
}

async function fetchTiles(tileUrls, batchSize = 20) {
  const results = [];
  for (let i = 0; i < tileUrls.length; i += batchSize) {
    const batch = tileUrls.slice(i, i + batchSize).map(url =>
      httpGet(url).then(html => parseTile(html)).catch(() => null)
    );
    const batchResult = await Promise.all(batch);
    batchResult.forEach(r => { if (r) results.push(r); });
  }
  return results;
}

async function scrapeAldi(_browser, maxResults = 300) {
  console.log("[Aldi] HTTP scraper start...");
  const mainHtml = await httpGet("https://www.aldi.be/nl/onze-aanbiedingen.html");

  // Extract tile URLs (only current week, filter out "undefined" dates)
  const tileMatches = [...mainHtml.matchAll(/data-tile-url="([^"]+)"/g)];
  const tileUrls = [...new Set(tileMatches.map(m => `https://www.aldi.be${m[1]}`))];
  console.log(`[Aldi] ${tileUrls.length} tile URLs gevonden`);

  const products = await fetchTiles(tileUrls, 20);
  console.log(`[Aldi] ${products.length} producten gescraped`);

  return products.slice(0, maxResults).map((p, i) => ({
    id: 7000 + i,
    store: "Aldi", storeColor: "#1E5AA8", storeLogo: "AL",
    item: p.name,
    deal: "Aanbieding",
    category: p.cat || "Overig",
    originalPrice: p.price,
    newPrice: p.price,
    savings: 0,
    emoji: categoryToEmoji(p.cat),
    validUntil: tsDutch(p.ts),
    hot: false,
    description: "",
    image: p.image,
  }));
}

module.exports = { scrapeAldi };
