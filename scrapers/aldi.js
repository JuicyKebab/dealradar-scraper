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

    // Aldi Belgium - probeer directe URL's
    const urls = [
      "https://www.aldi.be/nl/weekaanbieding.html",
      "https://www.aldi.be/nl/",
    ];

    let loaded = false;
    for (const url of urls) {
      try {
        await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
        loaded = true;
        break;
      } catch { /* try next */ }
    }

    if (!loaded) throw new Error("Aldi: geen enkele URL geladen");
    await page.waitForTimeout(3000);

    const products = await page.evaluate(() => {
      const results = [];
      // Aldi Belgium uses specific tile components
      const selectors = [
        ".mod-article-tile",
        "[class*='article-tile']",
        "[class*='product-tile']",
        "[class*='offer-tile']",
        "[class*='OfferTile']",
        "[class*='ArticleTile']",
        "[class*='mod-article']",
      ];

      let cards = [];
      for (const sel of selectors) {
        cards = Array.from(document.querySelectorAll(sel));
        if (cards.length > 2) break;
      }

      // Brede fallback: alle elementen met afbeelding en prijs
      if (cards.length === 0) {
        const allEls = Array.from(document.querySelectorAll("article, li")).filter(el => {
          return el.querySelector("img") &&
                 el.textContent.includes("€") &&
                 el.offsetHeight > 80 &&
                 el.offsetWidth > 80;
        });
        cards = allEls.filter(el => !allEls.includes(el.parentElement)).slice(0, 30);
      }

      // Nav items te filteren
      const NAV_BLACKLIST = ["boodschappenlijst", "aanmelden", "registreren", "zoeken", "menu", "home", "winkel", "contact"];

      for (const card of cards.slice(0, 25)) {
        const nameEl = card.querySelector(
          ".mod-article-tile__name, [class*='title'], [class*='name'], [class*='heading'], h2, h3, h4, strong"
        );
        const name = nameEl?.textContent?.trim();
        if (!name || name.length < 3 || name.length > 100) continue;
        if (NAV_BLACKLIST.some(b => name.toLowerCase().includes(b))) continue;

        const allText = card.textContent;
        const priceMatch = allText.match(/€\s*(\d+)[,.](\d{2})/);
        const newPrice = priceMatch ? parseFloat(`${priceMatch[1]}.${priceMatch[2]}`) : 0;

        const oldEl = card.querySelector("s, del, [class*='before'], [class*='old'], [class*='was']");
        const oldMatch = oldEl?.textContent?.match(/(\d+)[,.](\d{2})/);
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
