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

    await page.goto("https://www.mijnspar.be/nl/promoties", { waitUntil: "domcontentloaded", timeout: 45000 });
    await page.waitForTimeout(4000);

    // Check API intercepts
    for (const { json } of apiData) {
      const items = json.results || json.products || json.items || json.promotions || [];
      if (items.length > 0) {
        return items.slice(0, maxResults).map((p, i) => ({
          id: 8000 + i,
          store: "Spar", storeColor: "#007A33", storeLogo: "S",
          item: p.name || p.title || "Onbekend",
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

    // Debug: dump page structure to find correct selectors
    const pageInfo = await page.evaluate(() => {
      // Find all elements that look like product cards
      const results = [];
      const allEls = Array.from(document.querySelectorAll("*"));

      // Find classes that appear multiple times (likely list items)
      const classCounts = {};
      for (const el of allEls) {
        for (const cls of el.classList) {
          classCounts[cls] = (classCounts[cls] || 0) + 1;
        }
      }

      // Classes appearing 5-50 times are likely product cards
      const candidates = Object.entries(classCounts)
        .filter(([, count]) => count >= 5 && count <= 50)
        .map(([cls]) => cls);

      // Try each candidate as a product card selector
      for (const cls of candidates.slice(0, 20)) {
        const els = document.querySelectorAll(`.${cls}`);
        if (els.length < 4) continue;
        const sample = els[0];
        const text = sample?.textContent?.trim().slice(0, 100);
        const hasImg = !!sample?.querySelector("img");
        const hasPrice = text?.includes("€") || text?.includes(",");
        if (hasImg && hasPrice) {
          results.push({ cls, count: els.length, text });
        }
      }
      return results;
    });

    console.log("[Spar] Page structure:", JSON.stringify(pageInfo.slice(0, 5)));

    // Try to scrape based on discovered structure
    const products = await page.evaluate((pageInfo) => {
      const results = [];

      // Try discovered classes first
      for (const { cls } of pageInfo) {
        const cards = Array.from(document.querySelectorAll(`.${cls}`));
        if (cards.length < 4) continue;

        for (const card of cards.slice(0, 25)) {
          // Try to find name: any text element that's not a price
          const textEls = Array.from(card.querySelectorAll("p, span, h2, h3, h4, strong, a"));
          let name = null;
          for (const el of textEls) {
            const text = el.textContent?.trim();
            if (text && text.length > 2 && text.length < 80 && !text.includes("€") && !/^\d/.test(text)) {
              name = text;
              break;
            }
          }
          if (!name) continue;

          const allText = card.textContent;
          const priceMatch = allText.match(/€\s*(\d+)[,.](\d{2})/);
          const newPrice = priceMatch ? parseFloat(`${priceMatch[1]}.${priceMatch[2]}`) : 0;

          const oldEl = card.querySelector("s, del, [class*='before'], [class*='old'], [class*='was']");
          const oldMatch = oldEl?.textContent?.match(/(\d+)[,.](\d{2})/);
          const originalPrice = oldMatch ? parseFloat(`${oldMatch[1]}.${oldMatch[2]}`) : newPrice;

          const image = card.querySelector("img")?.src || null;
          const badge = card.querySelector("[class*='badge'], [class*='discount'], [class*='promo'], [class*='label']")?.textContent?.trim() || "";
          results.push({ name, newPrice, originalPrice, badge, image });
        }
        if (results.length > 0) break;
      }

      // Generic fallback
      if (results.length === 0) {
        const cards = Array.from(document.querySelectorAll("article, li")).filter(el =>
          el.querySelector("img") && el.textContent.includes("€") && el.offsetHeight > 80
        );
        for (const card of cards.slice(0, 25)) {
          const textEls = Array.from(card.querySelectorAll("p, span, h2, h3, h4, strong"));
          let name = null;
          for (const el of textEls) {
            const text = el.textContent?.trim();
            if (text && text.length > 2 && text.length < 80 && !text.includes("€") && !/^\d/.test(text)) {
              name = text;
              break;
            }
          }
          if (!name) continue;
          const priceMatch = card.textContent.match(/€\s*(\d+)[,.](\d{2})/);
          const newPrice = priceMatch ? parseFloat(`${priceMatch[1]}.${priceMatch[2]}`) : 0;
          const image = card.querySelector("img")?.src || null;
          results.push({ name, newPrice, originalPrice: newPrice, badge: "", image });
        }
      }

      return results;
    }, pageInfo);

    return products.slice(0, maxResults).map((p, i) => {
      const savings = p.originalPrice > p.newPrice && p.newPrice > 0
        ? Math.round((1 - p.newPrice / p.originalPrice) * 100) : 0;
      return {
        id: 8000 + i,
        store: "Spar", storeColor: "#007A33", storeLogo: "S",
        item: p.name,
        deal: p.badge || (savings > 0 ? `-${savings}%` : "Aanbieding"),
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

module.exports = { scrapeSpar };
