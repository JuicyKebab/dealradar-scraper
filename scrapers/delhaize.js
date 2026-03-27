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

// Recursief zoeken naar product-arrays in een willekeurig JSON-object
function findProductArrays(obj, depth = 0, found = []) {
  if (depth > 6 || !obj || typeof obj !== "object") return found;
  if (Array.isArray(obj)) {
    if (obj.length >= 3 && obj[0] && typeof obj[0] === "object"
        && (obj[0].name || obj[0].title || obj[0].productName || obj[0].displayName
            || obj[0].label || obj[0].ean || obj[0].id)) {
      found.push(obj);
    }
    obj.forEach(item => findProductArrays(item, depth + 1, found));
  } else {
    for (const val of Object.values(obj)) {
      findProductArrays(val, depth + 1, found);
    }
  }
  return found;
}

async function fetchDelhaizeAPI() {
  const headers = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
    "Accept": "application/json, text/html,*/*",
    "Accept-Language": "nl-BE,nl;q=0.9",
    "Referer": "https://www.delhaize.be/nl/promoties",
  };

  // Probeer __NEXT_DATA__ uit de HTML te halen (SSR)
  try {
    const htmlRes = await fetch("https://www.delhaize.be/nl/promoties", { headers: { ...headers, Accept: "text/html" } });
    if (htmlRes.ok) {
      const html = await htmlRes.text();
      const match = html.match(/<script id="__NEXT_DATA__"[^>]*>([^<]+)<\/script>/);
      if (match) {
        const nextData = JSON.parse(match[1]);
        const arrays = findProductArrays(nextData);
        if (arrays.length > 0) {
          const best = arrays.sort((a, b) => b.length - a.length)[0];
          console.log("[Delhaize] __NEXT_DATA__ producten:", best.length, "sample keys:", Object.keys(best[0] || {}).slice(0, 8).join(", "));
          return best;
        }
        console.log("[Delhaize] __NEXT_DATA__ aanwezig maar geen producten gevonden, top-keys:", Object.keys(nextData).slice(0, 10).join(", "));
      }
    }
  } catch (e) { console.log("[Delhaize] __NEXT_DATA__ fetch fout:", e.message); }

  // Delhaize OCAPI product search — promoties filter
  const endpoints = [
    "https://www.delhaize.be/api/2.0/products?q=*&refinements=c_isPromo%3Dtrue&count=100&locale=nl_BE",
    "https://www.delhaize.be/on/demandware.store/Sites-DelhBE-Site/nl_BE/Product-GetPromotions?count=100",
    "https://www.delhaize.be/on/demandware.store/Sites-DelhBE-Site/nl_BE/Search-Show?q=promo&srule=best-matches&sz=100&format=ajax",
  ];

  for (const url of endpoints) {
    try {
      const res = await fetch(url, { headers });
      if (!res.ok) { console.log("[Delhaize] API", url.slice(0, 60), "->", res.status); continue; }
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
          json.results, json.products, json.items, json.promotions,
          json.data?.products, json.data?.promotions,
          json.data?.promotionProducts,
          json.data?.promotionPage?.products,
          json.data?.searchProducts?.results,
          json.data?.promotedProducts,
          json.data?.productSearch?.productHits,
          json.hits, json.searchResult?.hits,
          Array.isArray(json) ? json : null,
        ].filter(a => Array.isArray(a) && a.length >= 1 && a[0] && typeof a[0] === "object"
          && (a[0]?.name || a[0]?.title || a[0]?.productName || a[0]?.displayName
              || a[0]?.label || a[0]?.ean || a[0]?.id || a[0]?.productId));

        if (candidates.length > 0) {
          console.log("[Delhaize] API intercept:", url.slice(0, 80), "->", candidates[0].length,
            "sample keys:", Object.keys(candidates[0][0] || {}).slice(0, 8).join(", "));
          apiProducts.push(...candidates[0]);
        } else if (typeof json === "object" && !Array.isArray(json)) {
          // Dieper zoeken via recursie
          const deepArrays = findProductArrays(json);
          if (deepArrays.length > 0) {
            const best = deepArrays.sort((a, b) => b.length - a.length)[0];
            console.log("[Delhaize] Deep intercept:", url.slice(0, 80), "->", best.length);
            apiProducts.push(...best);
          }
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
