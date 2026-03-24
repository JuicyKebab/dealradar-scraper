// Lidl Belgium — Playwright scraper
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
  };
  if (!cat) return "🛒";
  const lower = cat.toLowerCase();
  for (const [key, emoji] of Object.entries(map)) {
    if (lower.includes(key)) return emoji;
  }
  return "🛒";
}

async function scrapeLidl(browser, maxResults = 15) {
  const page = await browser.newPage();
  try {
    await page.setExtraHTTPHeaders({ "Accept-Language": "nl-BE,nl;q=0.9" });
    await page.goto("https://www.lidl.be/nl/aanbiedingen", { waitUntil: "domcontentloaded", timeout: 30000 });

    // Wait for product tiles to load
    await page.waitForSelector('[class*="offer"], [class*="product"], [class*="tile"]', { timeout: 15000 }).catch(() => {});

    // Try to extract from window.__INITIAL_STATE__ or similar
    const jsData = await page.evaluate(() => {
      // Try various global state objects
      const candidates = [
        window.__INITIAL_STATE__,
        window.__REDUX_STATE__,
        window.__APP_STATE__,
        window.initialState,
        window.__data,
      ];
      for (const c of candidates) {
        if (c && typeof c === "object") return JSON.stringify(c);
      }

      // Try Next.js data
      const nextData = document.getElementById("__NEXT_DATA__");
      if (nextData) return nextData.textContent;

      return null;
    });

    if (jsData) {
      try {
        const parsed = JSON.parse(jsData);
        // Navigate the structure to find offers
        const findArrays = (obj, depth = 0) => {
          if (depth > 5) return [];
          if (Array.isArray(obj) && obj.length > 0 && (obj[0].name || obj[0].title)) return [obj];
          if (typeof obj === "object" && obj !== null) {
            return Object.values(obj).flatMap(v => findArrays(v, depth + 1));
          }
          return [];
        };
        const arrays = findArrays(parsed);
        const products = arrays.sort((a, b) => b.length - a.length)[0];
        if (products && products.length > 0) {
          return products.slice(0, maxResults).map((p, i) => ({
            id: 4000 + i,
            store: "Lidl", storeColor: "#0050AA", storeLogo: "L",
            item: p.name || p.title || p.productName || "Onbekend",
            deal: p.discount || p.promotionText || p.savingsText || "Aanbieding",
            category: p.category || p.categoryName || "Overig",
            originalPrice: p.regularPrice || p.originalPrice || p.fullPrice || 0,
            newPrice: p.price || p.currentPrice || p.salePrice || 0,
            savings: p.savings || 0,
            emoji: categoryToEmoji(p.category || p.categoryName),
            validUntil: dutchDate(7),
            hot: false,
            description: p.description || "",
            image: p.image || p.imageUrl || p.thumbnail || null,
          }));
        }
      } catch { /* continue to HTML scraping */ }
    }

    // Scrape product tiles from HTML
    const products = await page.evaluate(() => {
      const results = [];
      // Lidl uses specific class patterns
      const selectors = [
        ".offer-tile",
        ".product-grid-box",
        "[data-qa='offer-tile']",
        "[class*='OfferTile']",
        "[class*='ProductTile']",
        ".n-product-card",
      ];

      let cards = [];
      for (const sel of selectors) {
        cards = Array.from(document.querySelectorAll(sel));
        if (cards.length > 0) break;
      }

      for (const card of cards.slice(0, 20)) {
        const name = card.querySelector("[class*='title'], [class*='name'], h2, h3, h4")?.textContent?.trim();
        if (!name || name.length < 3) continue;

        const priceText = card.querySelector("[class*='price--discount'], [class*='price__amount'], [class*='price']")?.textContent || "";
        const priceMatch = priceText.match(/(\d+)[,.](\d{2})/);
        const newPrice = priceMatch ? parseFloat(`${priceMatch[1]}.${priceMatch[2]}`) : 0;

        const oldPriceText = card.querySelector("[class*='price--regular'], [class*='price--old'], s, del")?.textContent || "";
        const oldMatch = oldPriceText.match(/(\d+)[,.](\d{2})/);
        const originalPrice = oldMatch ? parseFloat(`${oldMatch[1]}.${oldMatch[2]}`) : newPrice;

        const promoText = card.querySelector("[class*='discount'], [class*='badge'], [class*='label']")?.textContent?.trim() || "";
        const image = card.querySelector("img")?.src || null;

        results.push({ name, newPrice, originalPrice, promoText, image });
      }
      return results;
    });

    return products.slice(0, maxResults).map((p, i) => {
      const savings = p.originalPrice > p.newPrice ? Math.round((1 - p.newPrice / p.originalPrice) * 100) : 0;
      return {
        id: 4000 + i,
        store: "Lidl", storeColor: "#0050AA", storeLogo: "L",
        item: p.name,
        deal: p.promoText || (savings > 0 ? `-${savings}%` : "Aanbieding"),
        category: "Overig",
        originalPrice: p.originalPrice,
        newPrice: p.newPrice,
        savings,
        emoji: "🛒",
        validUntil: dutchDate(7),
        hot: savings >= 30,
        description: "",
        image: p.image,
      };
    });
  } finally {
    await page.close();
  }
}

module.exports = { scrapeLidl };
