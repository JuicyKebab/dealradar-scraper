// Delhaize Belgium — directe API + Playwright fallback
const _DDAYS = ["zo", "ma", "di", "wo", "do", "vr", "za"];
const _DMONTHS = ["januari", "februari", "maart", "april", "mei", "juni", "juli", "augustus", "september", "oktober", "november", "december"];

function dutchDate(daysFromNow = 7) {
  const d = new Date();
  d.setDate(d.getDate() + daysFromNow);
  return `${_DDAYS[d.getDay()]} ${d.getDate()} ${_DMONTHS[d.getMonth()]}`;
}
function isoToDutch(dateStr) {
  if (!dateStr) return dutchDate(7);
  const d = new Date(dateStr);
  if (isNaN(d)) return dutchDate(7);
  return `${_DDAYS[d.getDay()]} ${d.getDate()} ${_DMONTHS[d.getMonth()]}`;
}
function categoryToEmoji(cat) {
  const map = {
    "dranken": "🥤", "zuivel": "🥛", "vlees": "🥩", "brood": "🍞",
    "diepvries": "🧊", "groenten": "🥦", "fruit": "🍎", "koeken": "🍫",
    "chocolade": "🍫", "wijn": "🍷", "bier": "🍺", "snacks": "🍿",
    "kaas": "🧀", "charcuterie": "🥓",
  };
  if (!cat) return "🛒";
  const lower = cat.toLowerCase();
  for (const [key, emoji] of Object.entries(map)) { if (lower.includes(key)) return emoji; }
  return "🛒";
}

function mapDelhaize(p, i) {
  const orig = p.price?.regularPrice ?? p.price?.value ?? p.regularPrice ?? p.originalPrice ?? 0;
  const curr = p.price?.promotionPrice ?? p.promoPrice?.value ?? p.promotionPrice ?? p.discountedPrice ?? orig;
  const savings = orig > curr && orig > 0 ? Math.round((1 - curr / orig) * 100) : 0;
  return {
    id: 5000 + i,
    store: "Delhaize", storeColor: "#E4002B", storeLogo: "D",
    item: p.name || p.productName || p.title || "Onbekend",
    deal: savings > 0 ? `-${savings}%` : (p.promotionDescription || p.promoText || "Promo"),
    category: p.categories?.[0]?.name || p.topCategory || p.categoryName || "Overig",
    originalPrice: orig, newPrice: curr, savings,
    emoji: categoryToEmoji(p.categories?.[0]?.name || p.categoryName),
    validUntil: isoToDutch(p.promotionEndDate || p.endDate || p.validUntilDate),
    hot: savings >= 30,
    description: p.description || p.summary || "",
    image: p.images?.[0]?.url || p.imageUrl || p.thumbnail || null,
  };
}

async function fetchDelhaizeAPI() {
  const headers = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
    "Accept": "application/json",
    "Accept-Language": "nl-BE,nl;q=0.9",
    "Referer": "https://www.delhaize.be/nl/promoties",
  };

  // Delhaize OCAPI product search — promoties filter
  const endpoints = [
    "https://www.delhaize.be/api/2.0/products?q=*&refinements=c_isPromo%3Dtrue&count=100&locale=nl_BE",
    "https://www.delhaize.be/on/demandware.store/Sites-DelhBE-Site/nl_BE/Product-GetPromotions?count=100",
    "https://www.delhaize.be/on/demandware.store/Sites-DelhBE-Site/nl_BE/Search-Show?q=promo&srule=best-matches&sz=100&format=ajax",
  ];

  for (const url of endpoints) {
    try {
      const res = await fetch(url, { headers });
      if (!res.ok) continue;
      const ct = res.headers.get("content-type") || "";
      if (!ct.includes("application/json")) continue;
      const data = await res.json();
      const products = data.hits || data.products || data.results || data.data?.products || [];
      if (products.length >= 1) {
        console.log("[Delhaize] API:", url.slice(0, 60), "->", products.length);
        return products;
      }
    } catch { /* try next */ }
  }
  return null;
}

async function scrapeDelhaize(browser, maxResults = 50) {
  // Probeer eerst directe API
  const apiResult = await fetchDelhaizeAPI();
  if (apiResult && apiResult.length > 2) {
    return apiResult.slice(0, maxResults).map(mapDelhaize);
  }

  // Playwright fallback met uitgebreide response-interceptie
  const page = await browser.newPage();
  try {
    await page.setExtraHTTPHeaders({ "Accept-Language": "nl-BE,nl;q=0.9" });

    const apiProducts = [];
    page.on("response", async (response) => {
      const ct = response.headers()["content-type"] || "";
      const url = response.url();
      if (!ct.includes("application/json")) return;
      try {
        const json = await response.json();
        const candidates = [
          json.results, json.products, json.items,
          json.data?.products, json.data?.promotions,
          json.data?.promotionProducts,
          json.data?.promotionPage?.products,
          json.data?.searchProducts?.results,
          json.data?.promotedProducts,
          json.data?.productSearch?.productHits,
          json.hits,
          Array.isArray(json) ? json : null,
        ].filter(a => Array.isArray(a) && a.length >= 1
          && (a[0]?.name || a[0]?.title || a[0]?.productName)
          && typeof (a[0]?.name || a[0]?.title || a[0]?.productName) === "string");

        if (candidates.length > 0) {
          console.log("[Delhaize] API intercept:", url.slice(0, 80), "->", candidates[0].length);
          apiProducts.push(...candidates[0]);
        }
      } catch { /* skip */ }
    });

    await page.goto("https://www.delhaize.be/nl/promoties", { waitUntil: "domcontentloaded", timeout: 45000 });

    // Cookie consent
    try {
      await page.waitForSelector("#didomi-notice-agree-button", { timeout: 8000 });
      await page.click("#didomi-notice-agree-button");
      console.log("[Delhaize] Cookie geaccepteerd");
      await page.waitForTimeout(4000);
    } catch { /* geen banner */ }

    await page.waitForTimeout(5000);
    for (let i = 1; i <= 4; i++) {
      await page.evaluate((p) => window.scrollTo(0, document.body.scrollHeight * p), i / 4);
      await page.waitForTimeout(1500);
    }
    await page.waitForTimeout(3000);

    if (apiProducts.length > 0) {
      console.log("[Delhaize] Totaal API:", apiProducts.length);
      const unique = apiProducts.filter((p, i, arr) =>
        arr.findIndex(x => (x.id || x.productId || x.ean) === (p.id || p.productId || p.ean)) === i
      );
      return unique.slice(0, maxResults).map(mapDelhaize);
    }

    console.log("[Delhaize] Geen producten gevonden");
    return [];
  } finally {
    await page.close();
  }
}

module.exports = { scrapeDelhaize };
