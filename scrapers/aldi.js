// Aldi Belgium — Playwright scraper
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

async function scrapeAldi(browser, maxResults = 15) {
  const page = await browser.newPage();
  try {
    await page.setExtraHTTPHeaders({ "Accept-Language": "nl-BE,nl;q=0.9" });

    // Intercept ALL JSON responses — log elke URL zodat we de price-API kunnen vinden
    const apiData = [];
    page.on("response", async (response) => {
      const url = response.url();
      const ct = response.headers()["content-type"] || "";
      if (!ct.includes("application/json")) return;
      // Skip tracking/consent
      if (url.includes("batch.com") || url.includes("usercentrics") || url.includes("cookielaw")
          || url.includes("analytics") || url.includes("doubleclick") || url.includes("facebook")) return;
      try {
        const json = await response.json();
        const items = json.hits || json.results?.[0]?.hits || json.products || json.results
          || json.articles || json.items || json.data?.products || json.data?.articles
          || (Array.isArray(json) && json.length > 2 ? json : null)
          || [];
        if (items.length > 2) {
          console.log(`[Aldi] Intercepted ${items.length} items from: ${url.slice(0, 120)}`);
          console.log(`[Aldi] Sample keys: ${Object.keys(items[0] || {}).slice(0, 10).join(", ")}`);
          apiData.push({ url, items });
        } else if (typeof json === "object" && !Array.isArray(json) && Object.keys(json).length > 0) {
          console.log(`[Aldi] JSON (geen array) van: ${url.slice(0, 120)} keys: ${Object.keys(json).slice(0, 8).join(", ")}`);
        }
      } catch { /* skip */ }
    });

    // Try correct Aldi Belgium URLs
    const urls = [
      "https://www.aldi.be/nl/weekaanbieding.html",
      "https://www.aldi.be/nl/onze-aanbiedingen.html",
      "https://www.aldi.be/nl/aanbiedingen.html",
      "https://www.aldi.be/nl/",
    ];

    let loaded = false;
    for (const url of urls) {
      try {
        const response = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
        if (response?.status() !== 404) {
          loaded = true;
          console.log("[Aldi] Loaded:", url);
          break;
        }
      } catch { /* try next */ }
    }

    if (!loaded) {
      await page.goto("https://www.aldi.be/nl/", { waitUntil: "domcontentloaded", timeout: 30000 });
    }

    // Scroll om lazy-loading te triggeren
    await page.waitForTimeout(3000);
    for (let i = 1; i <= 4; i++) {
      await page.evaluate((p) => window.scrollTo(0, document.body.scrollHeight * p), i / 4);
      await page.waitForTimeout(1000);
    }
    await page.waitForTimeout(3000);

    // Check API intercepts — alleen gebruiken als er echte prijzen in zitten
    if (apiData.length > 0) {
      const best = apiData.sort((a, b) => b.items.length - a.items.length)[0];
      const itemsWithPrice = best.items.filter(p =>
        (p.regularPrice || p.originalPrice || p.price || p.salePrice || p.promoPrice
         || p.priceWithTax || p.currentPrice || p.listPrice || p.price?.value
         || p.price?.regular || p.price?.sale) > 0
      );
      if (itemsWithPrice.length > 0) {
        console.log("[Aldi] API intercept met prijzen:", best.url, "->", itemsWithPrice.length, "items");
        return itemsWithPrice.slice(0, maxResults).map((p, i) => {
          const orig = p.regularPrice || p.originalPrice || p.listPrice || p.priceWithTax
            || p.currentPrice || p.price?.regular || p.price?.value || p.price || 0;
          const curr = p.salePrice || p.promoPrice || p.price?.sale || p.price || orig;
          const savings = orig > curr ? Math.round((1 - curr / orig) * 100) : 0;
          return {
            id: 7000 + i,
            store: "Aldi", storeColor: "#1E5AA8", storeLogo: "AL",
            item: p.name || p.title || p.productName || "Onbekend",
            deal: savings > 0 ? `-${savings}%` : (p.promotionLabel || "Aanbieding"),
            category: p.category || p.categoryName || "Overig",
            originalPrice: orig, newPrice: curr, savings,
            emoji: "🛒",
            validUntil: isoToDutch(p.endDate || p.validUntil),
            hot: savings >= 30,
            description: p.description || "",
            image: p.image || p.imageUrl || p.thumbnail || null,
          };
        });
      }
      console.log("[Aldi] API zonder prijzen, val terug op HTML scraper");
    }

    // HTML scraping — log the actual page URL and classes found
    const pageInfo = await page.evaluate(() => ({
      url: location.href,
      title: document.title,
      classes: [...new Set(Array.from(document.querySelectorAll("[class]")).flatMap(el => [...el.classList]))].filter(c => c.includes("article") || c.includes("product") || c.includes("offer") || c.includes("tile") || c.includes("promo")),
    }));
    console.log("[Aldi] Page:", pageInfo.url, "| Classes:", pageInfo.classes.join(", "));

    const selectors = [
      ".mod-article-tile",
      "[class*='article-tile']",
      "[class*='product-tile']",
      "[class*='offer-tile']",
      "[data-t-name='ArticleTile']",
      "[data-t-name='ProductTile']",
    ];

    const products = await page.evaluate((selectors) => {
      const results = [];

      // Eerst: extraheer uit data-article JSON-attributen (AEM structuur, bevat echte prijzen)
      const articleEls = Array.from(document.querySelectorAll("[data-article]"));
      for (const el of articleEls) {
        try {
          const data = JSON.parse(el.getAttribute("data-article"));
          const info = data.productInfo || data;
          const name = info.productName || info.name;
          if (!name || name.length < 2) continue;
          const brand = info.brand && !["Not Owned", "n/a"].includes(info.brand) ? info.brand + " " : "";
          const price = parseFloat(info.priceWithTax) || parseFloat(info.price) || 0;
          const origPrice = parseFloat(info.originalPriceWithTax) || parseFloat(info.originalPrice) || price;
          const image = el.querySelector("img")?.src || el.querySelector("img")?.getAttribute("data-src") || null;
          results.push({ name: brand + name, newPrice: price, originalPrice: origPrice, image });
        } catch { /* skip */ }
      }
      if (results.length > 2) return results;

      // Fallback: HTML scraping
      let cards = [];
      for (const sel of selectors) {
        cards = Array.from(document.querySelectorAll(sel));
        if (cards.length > 2) break;
      }

      for (const card of cards.slice(0, 25)) {
        const nameEl = card.querySelector(".mod-article-tile__name, [class*='name'], [class*='title'], h2, h3, h4, strong, p");
        const name = nameEl?.textContent?.trim();
        if (!name || name.length < 2 || name.length > 120) continue;

        const allText = card.textContent || "";
        const priceMatch = allText.match(/€\s*(\d+)[,.](\d{2})/) || allText.match(/(\d+)[,.](\d{2})\s*€/);
        const newPrice = priceMatch ? parseFloat(`${priceMatch[1]}.${priceMatch[2]}`) : 0;

        const oldEl = card.querySelector("s, del, [class*='before'], [class*='old'], [class*='was'], [class*='regular'], [class*='normal']");
        const oldMatch = oldEl?.textContent?.match(/€?\s*(\d+)[,.](\d{2})/) || oldEl?.textContent?.match(/(\d+)[,.](\d{2})\s*€?/);
        const originalPrice = oldMatch ? parseFloat(`${oldMatch[1]}.${oldMatch[2]}`) : newPrice;

        const image = card.querySelector("img")?.src
          || card.querySelector("img")?.getAttribute("data-src")
          || null;

        results.push({ name, newPrice, originalPrice, image });
      }
      return results;
    }, selectors);

    console.log("[Aldi] HTML found:", products.length, "products");

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
