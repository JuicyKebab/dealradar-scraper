// Aldi Belgium — Playwright scraper
const _DDAYS = ["zo", "ma", "di", "wo", "do", "vr", "za"];
const _DMONTHS = ["januari", "februari", "maart", "april", "mei", "juni", "juli", "augustus", "september", "oktober", "november", "december"];

function dutchDate(daysFromNow = 7) {
  const d = new Date();
  d.setDate(d.getDate() + daysFromNow);
  return `${_DDAYS[d.getDay()]} ${d.getDate()} ${_DMONTHS[d.getMonth()]}`;
}

async function scrapeAldi(browser, maxResults = 15) {
  const page = await browser.newPage();
  try {
    await page.setExtraHTTPHeaders({ "Accept-Language": "nl-BE,nl;q=0.9" });

    // Aldi Belgium promotions
    await page.goto("https://www.aldi.be/nl/", { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForTimeout(2000);

    // Try to navigate to aanbiedingen section
    const offerLink = await page.$('[href*="aanbieding"], [href*="folder"], [href*="promo"]');
    if (offerLink) {
      await offerLink.click();
      await page.waitForTimeout(2000);
    }

    // Look for embedded JSON data
    const jsData = await page.evaluate(() => {
      // Check for structured data
      const scripts = Array.from(document.querySelectorAll("script[type='application/json'], script[type='application/ld+json']"));
      for (const s of scripts) {
        try {
          const data = JSON.parse(s.textContent);
          if (Array.isArray(data) && data.length > 0 && data[0].name) return JSON.stringify(data);
          if (data["@type"] === "ItemList") return JSON.stringify(data);
        } catch { /* skip */ }
      }

      // Check window data
      for (const key of Object.keys(window)) {
        if (key.includes("product") || key.includes("offer") || key.includes("promo")) {
          try {
            const val = window[key];
            if (Array.isArray(val) && val.length > 0) return JSON.stringify(val);
          } catch { /* skip */ }
        }
      }

      return null;
    });

    if (jsData) {
      try {
        const parsed = JSON.parse(jsData);
        const items = Array.isArray(parsed) ? parsed : (parsed.itemListElement || []);
        if (items.length > 0) {
          return items.slice(0, maxResults).map((p, i) => ({
            id: 7000 + i,
            store: "Aldi", storeColor: "#1E5AA8", storeLogo: "AL",
            item: p.name || p.item?.name || "Onbekend",
            deal: "Aanbieding",
            category: p.category || "Overig",
            originalPrice: 0,
            newPrice: parseFloat(p.offers?.price || p.price || 0),
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
        ".mod-article-tile",
        "[class*='article-tile']",
        "[class*='product-tile']",
        "[class*='offer-tile']",
        "[class*='OfferTile']",
        "[class*='ArticleTile']",
        ".product-card",
      ];

      let cards = [];
      for (const sel of selectors) {
        cards = Array.from(document.querySelectorAll(sel));
        if (cards.length > 2) break;
      }

      // Fallback: any section/article with a price
      if (cards.length === 0) {
        cards = Array.from(document.querySelectorAll("article, section, li")).filter(el => {
          const text = el.textContent;
          return text.includes("€") && el.querySelector("img");
        });
      }

      for (const card of cards.slice(0, 25)) {
        const name = card.querySelector("[class*='title'], [class*='name'], h2, h3, h4, p")?.textContent?.trim();
        if (!name || name.length < 3) continue;

        const priceText = card.querySelector("[class*='price'], .price")?.textContent || card.textContent || "";
        const priceMatch = priceText.match(/€\s*(\d+)[,.](\d{2})/);
        const newPrice = priceMatch ? parseFloat(`${priceMatch[1]}.${priceMatch[2]}`) : 0;

        const oldPriceText = card.querySelector("[class*='price--before'], s, del, [class*='old']")?.textContent || "";
        const oldMatch = oldPriceText.match(/(\d+)[,.](\d{2})/);
        const originalPrice = oldMatch ? parseFloat(`${oldMatch[1]}.${oldMatch[2]}`) : newPrice;

        const image = card.querySelector("img")?.src || card.querySelector("img")?.getAttribute("data-src") || null;
        results.push({ name, newPrice, originalPrice, image });
      }
      return results;
    });

    return products.slice(0, maxResults).map((p, i) => {
      const savings = p.originalPrice > p.newPrice && p.newPrice > 0
        ? Math.round((1 - p.newPrice / p.originalPrice) * 100) : 0;
      return {
        id: 7000 + i,
        store: "Aldi", storeColor: "#1E5AA8", storeLogo: "AL",
        item: p.name,
        deal: savings > 0 ? `-${savings}%` : "Aanbieding",
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

module.exports = { scrapeAldi };
