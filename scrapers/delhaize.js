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

const DELHAIZE_GQL = "https://www.delhaize.be/api/v1/";
const DELHAIZE_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
  "Content-Type": "application/json",
  "Accept": "application/json",
  "Accept-Language": "nl-BE,nl;q=0.9",
  "Origin": "https://www.delhaize.be",
  "Referer": "https://www.delhaize.be/nl/promoties",
};

const DELHAIZE_PROMO_QUERY = `
  query GetProductSearch($lang: String, $pageNumber: Int, $pageSize: Int) {
    productSearch: productSearchV2(
      lang: $lang
      searchQuery: "promotions"
      pageSize: $pageSize
      pageNumber: $pageNumber
    ) {
      products {
        name
        description
        price { value }
        images { url }
        categories { name }
        potentialPromotions { description promotionType endDate }
      }
      pagination {
        currentPage
        totalPages
        totalResults
        pageSize
      }
    }
  }
`;

// Haalt alle Delhaize promoties op via productSearchV2 (1540+ producten, gepagineerd)
async function fetchAllDelhaizePromos() {
  const PAGE_SIZE = 50; // server-max
  const MAX_PAGES = 31; // ~1540 / 50

  // Haal pagina 0 op om totalPages te weten
  async function fetchPage(pageNumber) {
    const res = await fetch(DELHAIZE_GQL, {
      method: "POST",
      headers: DELHAIZE_HEADERS,
      body: JSON.stringify({
        operationName: "GetProductSearch",
        query: DELHAIZE_PROMO_QUERY,
        variables: { lang: "nl", pageNumber, pageSize: PAGE_SIZE },
      }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    return data?.data?.productSearch || null;
  }

  try {
    const first = await fetchPage(0);
    if (!first?.products?.length) return null;
    const totalPages = Math.min(first.pagination?.totalPages ?? 1, MAX_PAGES);
    console.log(`[Delhaize] GQL: ${first.pagination?.totalResults} promoties, ${totalPages} pagina's`);

    const allProducts = [...first.products];

    // Haal resterende pagina's parallel op (max 5 tegelijk)
    for (let start = 1; start < totalPages; start += 5) {
      const batch = [];
      for (let p = start; p < Math.min(start + 5, totalPages); p++) {
        batch.push(fetchPage(p).then(r => r?.products || []).catch(() => []));
      }
      const results = await Promise.all(batch);
      results.forEach(prods => allProducts.push(...prods));
    }

    console.log(`[Delhaize] GQL totaal: ${allProducts.length} producten`);
    return allProducts;
  } catch (e) {
    console.log("[Delhaize] GQL paginering fout:", e.message);
    return null;
  }
}

function parseDelhaizeEndDate(str) {
  // "01/04/2026 21:59:00" → "wo 1 april"
  if (!str) return dutchDate(7);
  const [datePart] = str.split(" ");
  const [d, m, y] = datePart.split("/");
  if (!d || !m) return dutchDate(7);
  const dt = new Date(y, Number(m) - 1, Number(d));
  const days = ["zo","ma","di","wo","do","vr","za"];
  const months = ["januari","februari","maart","april","mei","juni","juli","augustus","september","oktober","november","december"];
  return `${days[dt.getDay()]} ${Number(d)} ${months[Number(m) - 1]}`;
}

function mapDelhaizeGQL(p, i) {
  const price = p.price?.value ?? 0;
  const promo = p.potentialPromotions?.[0];
  const dealText = promo?.description || "Promo";

  // Probeer percentage te parsen uit beschrijving (bv. "-20%", "20% korting")
  const pctMatch = dealText.match(/(\d+)\s*%/);
  const savings = pctMatch ? parseInt(pctMatch[1], 10) : 0;
  const newPrice = savings > 0 ? Math.round(price * (1 - savings / 100) * 100) / 100 : price;

  return {
    id: 5000 + i,
    store: "Delhaize", storeColor: "#E4002B", storeLogo: "D",
    item: p.name || "Onbekend",
    deal: dealText,
    category: p.categories?.[0]?.name || "Overig",
    originalPrice: price,
    newPrice,
    savings,
    emoji: categoryToEmoji(p.categories?.[0]?.name),
    validUntil: parseDelhaizeEndDate(promo?.endDate),
    hot: savings >= 30,
    description: p.description || "",
    image: p.images?.[0]?.url ? `https://www.delhaize.be${p.images[0].url}` : null,
  };
}

async function fetchDelhaizeAPI() {
  const headers = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
    "Accept": "text/html,*/*",
    "Accept-Language": "nl-BE,nl;q=0.9",
    "Referer": "https://www.delhaize.be/nl/promoties",
  };

  // Probeer __NEXT_DATA__ uit de HTML te halen
  try {
    const htmlRes = await fetch("https://www.delhaize.be/nl/promoties", { headers });
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
        console.log("[Delhaize] __NEXT_DATA__ aanwezig maar geen producten, top-keys:", Object.keys(nextData).slice(0, 10).join(", "));
      }
    }
  } catch (e) { console.log("[Delhaize] __NEXT_DATA__ fout:", e.message); }

  return null;
}

async function scrapeDelhaize(browser, maxResults = 1500) {
  // Probeer eerst productSearchV2 met volledige paginering (1540+ producten)
  const allPromos = await fetchAllDelhaizePromos();
  if (allPromos && allPromos.length > 0) {
    return allPromos.slice(0, maxResults).map((p, i) => mapDelhaizeGQL(p, i));
  }

  // Fallback: __NEXT_DATA__ uit HTML
  const apiResult = await fetchDelhaizeAPI();
  if (apiResult && apiResult.length > 2) {
    return apiResult.slice(0, maxResults).map(mapDelhaize);
  }

  // Playwright met uitgebreide cookie-selectors + response-interceptie
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
        // Log alle API calls voor debugging
        if (url.includes("delhaize") && !url.includes("bc.delhaize") && !url.includes("usercentrics")) {
          console.log("[Delhaize] Response:", url.slice(0, 100), "keys:", Object.keys(json).slice(0, 6).join(","));
        }
        // Check data.productSearch van de GraphQL endpoint
        const gqlProducts = json.data?.productSearch?.products;
        if (Array.isArray(gqlProducts) && gqlProducts.length > 0) {
          console.log("[Delhaize] GQL intercept:", gqlProducts.length, "producten via Playwright");
          apiProducts.push(...gqlProducts.map((p, i) => mapDelhaizeGQL(p, i)));
          return;
        }
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
        } else {
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

    // Cookie consent — probeer meerdere selectors
    const cookieSelectors = [
      "#didomi-notice-agree-button",
      "button[title*='accepter' i]",
      "button[title*='accepteren' i]",
      "button:has-text('Alles accepteren')",
      "button:has-text('Tout accepter')",
      "button:has-text('Accepteer')",
      "button:has-text('Accepter')",
      ".accept-all",
      "[data-purpose='accept-all']",
      "button[class*='accept']",
    ];
    let cookieDone = false;
    for (const sel of cookieSelectors) {
      try {
        await page.waitForSelector(sel, { timeout: 3000 });
        await page.click(sel);
        console.log("[Delhaize] Cookie geaccepteerd via:", sel);
        cookieDone = true;
        break;
      } catch { /* probeer volgende */ }
    }
    if (!cookieDone) console.log("[Delhaize] Geen cookie-banner gevonden");
    await page.waitForTimeout(cookieDone ? 5000 : 3000);

    for (let i = 1; i <= 5; i++) {
      await page.evaluate((p) => window.scrollTo(0, document.body.scrollHeight * p), i / 5);
      await page.waitForTimeout(1500);
    }
    await page.waitForTimeout(4000);

    if (apiProducts.length > 0) {
      console.log("[Delhaize] Totaal Playwright:", apiProducts.length);
      const alreadyMapped = apiProducts[0]?.store === "Delhaize" && apiProducts[0]?.id !== undefined;
      if (alreadyMapped) return apiProducts.slice(0, maxResults);
      const unique = apiProducts.filter((p, i, arr) =>
        arr.findIndex(x => (x.id || x.productId || x.ean || x.name) === (p.id || p.productId || p.ean || p.name)) === i
      );
      return unique.slice(0, maxResults).map(mapDelhaize);
    }

    // Laatste fallback: probeer productSearchV2 alsnog
    console.log("[Delhaize] Playwright leeg — probeer GQL fallback");
    const gqlProducts = await fetchAllDelhaizePromos();
    if (gqlProducts && gqlProducts.length > 0) {
      return gqlProducts.slice(0, maxResults).map((p, i) => mapDelhaizeGQL(p, i));
    }

    console.log("[Delhaize] Geen producten gevonden");
    return [];
  } finally {
    await page.close();
  }
}

module.exports = { scrapeDelhaize };
