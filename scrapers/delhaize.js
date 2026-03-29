// Delhaize Belgium — GraphQL productSearchV2 (1539+ deals) + Playwright fallback
const _DDAYS = ["zo", "ma", "di", "wo", "do", "vr", "za"];
const _DMONTHS = ["januari", "februari", "maart", "april", "mei", "juni", "juli", "augustus", "september", "oktober", "november", "december"];

function dutchDate(daysFromNow = 7) {
  const d = new Date();
  d.setDate(d.getDate() + daysFromNow);
  return `${_DDAYS[d.getDay()]} ${d.getDate()} ${_DMONTHS[d.getMonth()]}`;
}
function categoryToEmoji(cat) {
  const map = {
    "dranken": "🥤", "zuivel": "🥛", "vlees": "🥩", "brood": "🍞",
    "diepvries": "🧊", "groenten": "🥦", "fruit": "🍎", "koeken": "🍫",
    "chocolade": "🍫", "wijn": "🍷", "bier": "🍺", "snacks": "🍿",
    "kaas": "🧀", "charcuterie": "🥓", "hygiëne": "🧴", "pasta": "🍝",
  };
  if (!cat) return "🛒";
  const lower = cat.toLowerCase();
  for (const [key, emoji] of Object.entries(map)) { if (lower.includes(key)) return emoji; }
  return "🛒";
}

function parseDelhaizeEndDate(str) {
  // "01/04/2026 21:59:00" → "wo 1 april"
  if (!str) return dutchDate(7);
  const [datePart] = str.split(" ");
  const [d, m, y] = datePart.split("/");
  if (!d || !m) return dutchDate(7);
  const dt = new Date(Number(y), Number(m) - 1, Number(d));
  return `${_DDAYS[dt.getDay()]} ${Number(d)} ${_DMONTHS[Number(m) - 1]}`;
}

const GQL_ENDPOINT = "https://www.delhaize.be/api/v1/";
const GQL_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
  "Content-Type": "application/json",
  "Accept": "application/json, text/plain, */*",
  "Accept-Language": "nl-BE,nl;q=0.9",
  "Origin": "https://www.delhaize.be",
  "Referer": "https://www.delhaize.be/nl/promoties",
};

const GQL_QUERY = `
  query GetPromos($lang: String, $page: Int, $size: Int) {
    productSearch: productSearchV2(
      lang: $lang
      searchQuery: "promotions"
      pageSize: $size
      pageNumber: $page
    ) {
      products {
        name
        description
        price { value }
        images { url }
        categories { name }
        potentialPromotions { description promotionType endDate }
      }
      pagination { currentPage totalPages totalResults }
    }
  }
`;

function mapDeal(p, i) {
  const basePrice = p.price?.value ?? 0;
  const promo = p.potentialPromotions?.[0];
  const dealText = promo?.description || "Promo";

  // Alleen savings berekenen voor enkelvoudige kortingen (bv. "-25%", "-20%")
  // Multi-buy deals ("1+1 gratis", "2de tegen -50%") hebben savings=0 — prijs blijft basisprijs
  const isFlatDiscount = /^-\s*\d+\s*%$/.test(dealText.trim());
  const savings = isFlatDiscount ? parseInt(dealText.match(/(\d+)/)[1], 10) : 0;
  const newPrice = isFlatDiscount
    ? Math.round(basePrice * (1 - savings / 100) * 100) / 100
    : basePrice;

  // Effectief besparingspercentage voor multi-buy deals (voor sortering/hot-badge)
  let effectiveSavings = savings;
  if (!isFlatDiscount) {
    if (/1\+1 gratis|3\+3 gratis/i.test(dealText)) effectiveSavings = 33;
    else if (/2\+1 gratis|4\+2 gratis/i.test(dealText)) effectiveSavings = 25;
    else if (/2de tegen -(\d+)%/i.test(dealText)) {
      const m = dealText.match(/(\d+)%/);
      effectiveSavings = m ? Math.round(parseInt(m[1]) / 2) : 0;
    }
  }

  const imgUrl = p.images?.[0]?.url || null;

  return {
    id: 5000 + i,
    store: "Delhaize", storeColor: "#E4002B", storeLogo: "D",
    item: p.name || "Onbekend",
    deal: dealText,
    category: p.categories?.[0]?.name || "Overig",
    originalPrice: basePrice,
    newPrice,
    savings: effectiveSavings,
    emoji: categoryToEmoji(p.categories?.[0]?.name),
    validUntil: parseDelhaizeEndDate(promo?.endDate),
    hot: effectiveSavings >= 30,
    description: p.description || "",
    image: imgUrl ? (imgUrl.startsWith("http") ? imgUrl : `https://www.delhaize.be${imgUrl}`) : null,
  };
}

async function fetchPage(page, size) {
  const res = await fetch(GQL_ENDPOINT, {
    method: "POST",
    headers: GQL_HEADERS,
    body: JSON.stringify({
      operationName: "GetPromos",
      query: GQL_QUERY,
      variables: { lang: "nl", page, size },
    }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  return data?.data?.productSearch || null;
}

async function fetchAllViaGQL() {
  const PAGE_SIZE = 50;  // server-max is 50
  const MAX_PAGES = 32; // 1600 / 50

  const first = await fetchPage(0, PAGE_SIZE);
  if (!first?.products?.length) return null;

  const totalPages = Math.min(first.pagination?.totalPages ?? 1, MAX_PAGES);
  console.log(`[Delhaize] GQL: ${first.pagination?.totalResults} promoties, ${totalPages} pagina's`);

  const allProducts = [...first.products];

  for (let start = 1; start < totalPages; start += 5) {
    const batch = [];
    for (let p = start; p < Math.min(start + 5, totalPages); p++) {
      batch.push(fetchPage(p, PAGE_SIZE).then(r => r?.products || []).catch(() => []));
    }
    (await Promise.all(batch)).forEach(prods => allProducts.push(...prods));
  }

  console.log(`[Delhaize] GQL geladen: ${allProducts.length} producten`);
  return allProducts;
}

// Recursief zoeken naar product-arrays in JSON
function findProductArrays(obj, depth = 0, found = []) {
  if (depth > 6 || !obj || typeof obj !== "object") return found;
  if (Array.isArray(obj)) {
    if (obj.length >= 3 && obj[0] && typeof obj[0] === "object"
        && (obj[0].name || obj[0].title || obj[0].ean || obj[0].id)) found.push(obj);
    obj.forEach(item => findProductArrays(item, depth + 1, found));
  } else {
    for (const val of Object.values(obj)) findProductArrays(val, depth + 1, found);
  }
  return found;
}

async function scrapeDelhaize(browser, maxResults = 1600) {
  // Primair: GQL (werkt, geeft 1539+ producten)
  try {
    const products = await fetchAllViaGQL();
    if (products && products.length >= 20) {
      return products.slice(0, maxResults).map(mapDeal);
    }
  } catch (e) {
    console.log("[Delhaize] GQL fout:", e.message);
  }

  // Fallback: Playwright met GQL-interceptie
  console.log("[Delhaize] GQL mislukt, Playwright...");
  const page = await browser.newPage();
  try {
    await page.setExtraHTTPHeaders({ "Accept-Language": "nl-BE,nl;q=0.9" });
    const intercepted = [];
    const pending = [];

    page.on("response", (response) => {
      const ct = response.headers()["content-type"] || "";
      if (!ct.includes("application/json")) return;
      const p = (async () => {
        try {
          const json = await response.json();
          const prods = json.data?.productSearch?.products;
          if (Array.isArray(prods) && prods.length > 0) {
            console.log(`[Delhaize] Playwright GQL: ${prods.length} producten`);
            intercepted.push(...prods);
          }
        } catch { /* skip */ }
      })();
      pending.push(p);
    });

    await page.goto("https://www.delhaize.be/nl/promoties", { waitUntil: "domcontentloaded", timeout: 45000 });

    // Cookie consent
    for (const sel of ["#didomi-notice-agree-button", "button:has-text('Alles accepteren')", "button:has-text('Accepteer')", "[data-purpose='accept-all']"]) {
      try { await page.waitForSelector(sel, { timeout: 3000 }); await page.click(sel); break; } catch { /* volgende */ }
    }

    await page.waitForTimeout(3000);
    for (let i = 1; i <= 4; i++) {
      await page.evaluate((p) => window.scrollTo(0, document.body.scrollHeight * p), i / 4);
      await page.waitForTimeout(1500);
    }
    await page.waitForTimeout(3000);
    await Promise.allSettled(pending);

    if (intercepted.length > 0) {
      console.log(`[Delhaize] Playwright totaal: ${intercepted.length}`);
      return intercepted.slice(0, maxResults).map(mapDeal);
    }
    return [];
  } finally {
    await page.close();
  }
}

module.exports = { scrapeDelhaize };
