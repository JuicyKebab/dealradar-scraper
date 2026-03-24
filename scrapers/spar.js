// Spar Belgium (mijnspar.be) — AEM JSON API + Playwright fallback
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

function mapSparResult(p, i) {
  const orig = p.price?.regular || p.regularPrice || p.originalPrice || 0;
  const curr = p.price?.promo || p.promoPrice || p.salePrice || orig;
  const savings = orig > curr ? Math.round((1 - curr / orig) * 100) : 0;

  // AEM model structure uses different field names
  const title = p.title || p.name || p.pageTitle || p.navigationTitle || "Onbekend";
  const image = p.image?.path || p.imagePath || p.imageUrl
    || (p.image?.renditions?.[0]?.path ? `https://www.mijnspar.be${p.image.renditions[0].path}` : null);
  const badge = p.promotionLabel || p.label || p.badge || (savings > 0 ? `-${savings}%` : "Aanbieding");
  const endDate = p.endDate || p.promotionEndDate || p.offTime || null;

  return {
    id: 8000 + i,
    store: "Spar", storeColor: "#007A33", storeLogo: "S",
    item: title,
    deal: badge,
    category: p.category || p.tags?.[0] || "Overig",
    originalPrice: orig,
    newPrice: curr,
    savings,
    emoji: "🛒",
    validUntil: isoToDutch(endDate) || dutchDate(7),
    hot: savings >= 30,
    description: p.description || p.jcr_description || "",
    image,
  };
}

async function scrapeSpar(browser, maxResults = 15) {
  // Try direct AEM JSON API first (no browser needed)
  try {
    const apiUrl = "https://www.mijnspar.be/content/spar/nl/promoties/jcr:content/root/responsivegrid/responsivegrid/responsivegrid/filter_list_store_sp.model.json";
    const res = await fetch(apiUrl, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
        "Accept": "application/json",
        "Referer": "https://www.mijnspar.be/nl/promoties",
      },
    });
    if (res.ok) {
      const data = await res.json();
      const results = data.results || [];
      if (results.length > 0) {
        console.log("[Spar] AEM API works, got", results.length, "results. Keys:", Object.keys(results[0]).join(", "));
        return results.slice(0, maxResults).map((p, i) => mapSparResult(p, i));
      }
    }
  } catch (e) {
    console.log("[Spar] AEM API failed:", e.message);
  }

  // Browser fallback with correct selectors
  const page = await browser.newPage();
  try {
    await page.setExtraHTTPHeaders({ "Accept-Language": "nl-BE,nl;q=0.9" });

    // Intercept the AEM model JSON
    let modelData = null;
    page.on("response", async (response) => {
      if (response.url().includes("filter_list_store_sp.model.json")) {
        try {
          const json = await response.json();
          if (json.results?.length > 0) modelData = json;
        } catch { /* skip */ }
      }
    });

    await page.goto("https://www.mijnspar.be/nl/promoties", { waitUntil: "domcontentloaded", timeout: 45000 });
    await page.waitForTimeout(4000);

    if (modelData) {
      console.log("[Spar] Got model data via intercept:", modelData.results.length, "items");
      return modelData.results.slice(0, maxResults).map((p, i) => mapSparResult(p, i));
    }

    // HTML scraping with confirmed selectors from dump
    const products = await page.evaluate(() => {
      const results = [];
      const cards = Array.from(document.querySelectorAll(".card--promotion, .card.card--promotion"));

      for (const card of cards.slice(0, 25)) {
        const title = card.querySelector(".card__title")?.textContent?.trim();
        if (!title || title.length < 2) continue;

        const label = card.querySelector(".card__label")?.textContent?.trim() || "";
        const image = card.querySelector(".card__image img, .lazyload")?.getAttribute("src")
          || card.querySelector(".card__image img, .lazyload")?.getAttribute("data-src")
          || card.querySelector("img")?.src || null;

        const dateEl = card.querySelector(".price-info__date");
        const dateText = dateEl?.textContent?.trim() || "";

        // Price: look for any price element
        const priceText = card.querySelector("[class*='price']:not(.price-info__date)")?.textContent || card.textContent;
        const priceMatch = priceText.match(/€\s*(\d+)[,.](\d{2})/);
        const newPrice = priceMatch ? parseFloat(`${priceMatch[1]}.${priceMatch[2]}`) : 0;

        const oldEl = card.querySelector("s, del, [class*='before'], [class*='was']");
        const oldMatch = oldEl?.textContent?.match(/(\d+)[,.](\d{2})/);
        const originalPrice = oldMatch ? parseFloat(`${oldMatch[1]}.${oldMatch[2]}`) : newPrice;

        results.push({ title, label, image, newPrice, originalPrice, dateText });
      }
      return results;
    });

    console.log("[Spar] HTML scraping found:", products.length, "products");

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
