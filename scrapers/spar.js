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

    await page.goto("https://www.mijnspar.be/nl/promoties", { waitUntil: "domcontentloaded", timeout: 45000 });
    await page.waitForTimeout(4000);

    // Use confirmed selectors from dump: .card--promotion, .card__title, .card__label
    const products = await page.evaluate(() => {
      const results = [];
      const cards = Array.from(document.querySelectorAll(".card--promotion"));
      console.log("Spar cards found:", cards.length);

      for (const card of cards) {
        const title = card.querySelector(".card__title")?.textContent?.trim();
        if (!title || title.length < 2) continue;

        const label = card.querySelector(".card__label")?.textContent?.trim() || "";

        // Price: search the whole card text for a price pattern
        const cardText = card.textContent || "";
        const prices = [...cardText.matchAll(/(\d+)[,.](\d{2})/g)].map(m => parseFloat(`${m[1]}.${m[2]}`));
        const newPrice = prices.length > 0 ? Math.min(...prices) : 0;
        const originalPrice = prices.length > 1 ? Math.max(...prices) : newPrice;

        // Date: .price-info__date
        const dateText = card.querySelector(".price-info__date")?.textContent?.trim() || "";

        // Image
        const imgEl = card.querySelector(".card__image img, img.lazyload, img");
        const image = imgEl?.src || imgEl?.getAttribute("data-src") || imgEl?.getAttribute("data-lazy-src") || null;

        results.push({ title, label, newPrice, originalPrice, dateText, image });
      }
      return results;
    });

    console.log("[Spar] Found", products.length, "products via HTML. Titles:", products.slice(0, 3).map(p => p.title).join(", "));

    return products.slice(0, maxResults).map((p, i) => {
      const savings = p.originalPrice > p.newPrice && p.newPrice > 0
        ? Math.round((1 - p.newPrice / p.originalPrice) * 100) : 0;
      return {
        id: 8000 + i,
        store: "Spar", storeColor: "#007A33", storeLogo: "S",
        item: p.title,
        deal: p.label || (savings > 0 ? `-${savings}%` : "Aanbieding"),
        category: "Overig",
        originalPrice: p.originalPrice,
        newPrice: p.newPrice,
        savings,
        emoji: "🛒",
        validUntil: p.dateText || dutchDate(7),
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
