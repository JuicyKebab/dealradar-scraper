// Spar Belgium (mijnspar.be) — Playwright scraper
const _DDAYS = ["zo", "ma", "di", "wo", "do", "vr", "za"];
const _DMONTHS = ["januari", "februari", "maart", "april", "mei", "juni", "juli", "augustus", "september", "oktober", "november", "december"];

function dutchDate(daysFromNow = 7) {
  const d = new Date();
  d.setDate(d.getDate() + daysFromNow);
  return `${_DDAYS[d.getDay()]} ${d.getDate()} ${_DMONTHS[d.getMonth()]}`;
}

async function scrapeSpar(browser, maxResults = 15) {
  const page = await browser.newPage();
  try {
    await page.setExtraHTTPHeaders({ "Accept-Language": "nl-BE,nl;q=0.9" });

    // Intercept API calls
    const apiData = [];
    page.on("response", async (response) => {
      const url = response.url();
      if (url.includes("api") || url.includes("product") || url.includes("promo")) {
        const ct = response.headers()["content-type"] || "";
        if (ct.includes("application/json")) {
          try {
            const json = await response.json();
            apiData.push({ url, json });
          } catch { /* skip */ }
        }
      }
    });

    await page.goto("https://www.mijnspar.be/nl/promoties", { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForTimeout(3000);

    // Check API intercepts
    for (const { json } of apiData) {
      const items = json.results || json.products || json.items || json.promotions || [];
      if (items.length > 0) {
        return items.slice(0, maxResults).map((p, i) => ({
          id: 8000 + i,
          store: "Spar", storeColor: "#007A33", storeLogo: "S",
          item: p.name || "Onbekend",
          deal: p.promotionText || p.discount || "Promo",
          category: p.category || "Overig",
          originalPrice: p.regularPrice || p.originalPrice || 0,
          newPrice: p.price || p.salePrice || 0,
          savings: 0,
          emoji: "🛒",
          validUntil: dutchDate(7),
          hot: false,
          description: p.description || "",
          image: p.image || p.imageUrl || null,
        }));
      }
    }

    // Try embedded data
    const jsData = await page.evaluate(() => {
      const nextEl = document.getElementById("__NEXT_DATA__");
      if (nextEl) return nextEl.textContent;
      return null;
    });

    if (jsData) {
      try {
        const parsed = JSON.parse(jsData);
        const findProducts = (obj, depth = 0) => {
          if (depth > 6) return null;
          if (Array.isArray(obj) && obj.length > 0 && (obj[0].name || obj[0].title)) return obj;
          if (typeof obj === "object" && obj !== null) {
            for (const v of Object.values(obj)) {
              const found = findProducts(v, depth + 1);
              if (found) return found;
            }
          }
          return null;
        };
        const products = findProducts(parsed);
        if (products && products.length > 0) {
          return products.slice(0, maxResults).map((p, i) => ({
            id: 8000 + i,
            store: "Spar", storeColor: "#007A33", storeLogo: "S",
            item: p.name || "Onbekend",
            deal: p.promotionText || "Promo",
            category: p.category || "Overig",
            originalPrice: p.regularPrice || 0,
            newPrice: p.price || 0,
            savings: 0,
            emoji: "🛒",
            validUntil: dutchDate(7),
            hot: false,
            description: p.description || "",
            image: p.image || null,
          }));
        }
      } catch { /* continue */ }
    }

    // HTML scraping
    const products = await page.evaluate(() => {
      const results = [];
      const selectors = [
        "[class*='product-card']",
        "[class*='promo-card']",
        "[class*='offer-item']",
        "[class*='product-item']",
        "[class*='ProductCard']",
        "[class*='PromotionItem']",
        "article",
      ];

      let cards = [];
      for (const sel of selectors) {
        cards = Array.from(document.querySelectorAll(sel)).filter(el => el.querySelector("img") && el.textContent.includes("€"));
        if (cards.length > 2) break;
      }

      for (const card of cards.slice(0, 25)) {
        const name = card.querySelector("[class*='title'], [class*='name'], h2, h3, h4")?.textContent?.trim();
        if (!name || name.length < 3) continue;

        const priceText = card.querySelector("[class*='price']")?.textContent || "";
        const priceMatch = priceText.match(/(\d+)[,.](\d{2})/);
        const newPrice = priceMatch ? parseFloat(`${priceMatch[1]}.${priceMatch[2]}`) : 0;

        const image = card.querySelector("img")?.src || null;
        const badge = card.querySelector("[class*='badge'], [class*='discount'], [class*='promo']")?.textContent?.trim() || "";
        results.push({ name, newPrice, badge, image });
      }
      return results;
    });

    return products.slice(0, maxResults).map((p, i) => ({
      id: 8000 + i,
      store: "Spar", storeColor: "#007A33", storeLogo: "S",
      item: p.name,
      deal: p.badge || "Aanbieding",
      category: "Overig",
      originalPrice: p.newPrice,
      newPrice: p.newPrice,
      savings: 0,
      emoji: "🛒",
      validUntil: dutchDate(7),
      hot: false,
      description: "",
      image: p.image,
    }));
  } finally {
    await page.close();
  }
}

module.exports = { scrapeSpar };
