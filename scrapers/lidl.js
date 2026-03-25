// Lidl Belgium — Playwright scraper
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
  const map = { "dranken": "🥤", "zuivel": "🥛", "vlees": "🥩", "brood": "🍞", "diepvries": "🧊", "groenten": "🥦", "fruit": "🍎", "koeken": "🍫", "wijn": "🍷", "bier": "🍺" };
  if (!cat) return "🛒";
  const lower = cat.toLowerCase();
  for (const [key, emoji] of Object.entries(map)) {
    if (lower.includes(key)) return emoji;
  }
  return "🛒";
}

const LIDL_URLS = [
  "https://www.lidl.be/c/nl-BE/promoties/s10007548",
  "https://www.lidl.be/p/promoties/a5",
  "https://www.lidl.be/nl/aanbiedingen/",
  "https://www.lidl.be/c/nl-BE/aanbiedingen",
];

async function scrapeLidl(browser, maxResults = 15) {
  const page = await browser.newPage();
  try {
    await page.setExtraHTTPHeaders({ "Accept-Language": "nl-BE,nl;q=0.9" });

    // Intercept product API calls
    const apiProducts = [];
    page.on("response", async (response) => {
      const url = response.url();
      const ct = response.headers()["content-type"] || "";
      if (!ct.includes("application/json")) return;

      // Look for product/promo data
      if (url.includes("product") || url.includes("promo") || url.includes("offer") || url.includes("search") || url.includes("category")) {
        try {
          const json = await response.json();
          const items = json.products || json.results || json.hits || json.items || json.data?.products || [];
          if (items.length > 2 && (items[0]?.name || items[0]?.title || items[0]?.fullTitle)) {
            apiProducts.push(...items);
          }
        } catch { /* skip */ }
      }
    });

    // Try URLs until one doesn't 404
    let loaded = false;
    for (const url of LIDL_URLS) {
      try {
        const response = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
        if (response?.status() !== 404) {
          console.log("[Lidl] Loaded:", url, "status:", response?.status());
          loaded = true;
          break;
        }
        console.log("[Lidl] 404 at:", url);
      } catch (e) {
        console.log("[Lidl] Error at:", url, e.message);
      }
    }

    if (!loaded) throw new Error("Lidl: geen enkele URL geladen");

    // Accept cookie consent (OneTrust) — blocks product loading if not dismissed
    try {
      await page.waitForSelector("#onetrust-accept-btn-handler", { timeout: 5000 });
      await page.click("#onetrust-accept-btn-handler");
      console.log("[Lidl] Cookie banner accepted");
      await page.waitForTimeout(2000);
    } catch { /* no banner or already accepted */ }

    await page.waitForTimeout(5000);

    // Check API intercepts
    if (apiProducts.length > 0) {
      console.log("[Lidl] API intercept:", apiProducts.length, "products");
      return apiProducts.slice(0, maxResults).map((p, i) => {
        const orig = p.regularPrice || p.originalPrice || p.price?.regular || p.fullPrice || 0;
        const curr = p.price || p.currentPrice || p.price?.current || p.promotionPrice || orig;
        const savings = orig > curr && orig > 0 ? Math.round((1 - curr / orig) * 100) : 0;
        return {
          id: 4000 + i,
          store: "Lidl", storeColor: "#0050AA", storeLogo: "L",
          item: p.fullTitle || p.name || p.title || p.productName || "Onbekend",
          deal: savings > 0 ? `-${savings}%` : (p.promotionText || p.discount || "Aanbieding"),
          category: p.category || p.categoryName || "Overig",
          originalPrice: orig, newPrice: curr, savings,
          emoji: categoryToEmoji(p.category || p.categoryName),
          validUntil: isoToDutch(p.endDate || p.validUntil || p.promotionEndDate),
          hot: savings >= 30,
          description: p.description || "",
          image: p.image || p.imageUrl || p.thumbnail || p.images?.[0]?.url || null,
        };
      });
    }

    // Log page info for debugging
    const pageInfo = await page.evaluate(() => ({
      url: location.href,
      title: document.title,
      productClasses: [...new Set(Array.from(document.querySelectorAll("[class]"))
        .flatMap(el => [...el.classList])
        .filter(c => c.includes("product") || c.includes("tile") || c.includes("card") || c.includes("offer") || c.includes("item") || c.includes("promo"))
      )].slice(0, 20),
    }));
    console.log("[Lidl] Page:", pageInfo.url, "| Product classes:", pageInfo.productClasses.join(", "));

    // HTML scraping with Lidl-specific selectors
    const products = await page.evaluate(() => {
      const results = [];
      const selectors = [
        ".product-grid-box",
        ".n-product-card",
        "[data-product-id]",
        "[class*='product-grid']",
        "[class*='ProductCard']",
        "[class*='offer-card']",
        "article[class*='product']",
        "li[class*='product']",
      ];

      let cards = [];
      for (const sel of selectors) {
        cards = Array.from(document.querySelectorAll(sel));
        if (cards.length > 2) break;
      }

      console.log("Lidl cards found:", cards.length, "with selectors");

      for (const card of cards.slice(0, 25)) {
        const name = card.querySelector("[class*='title'], [class*='name'], [class*='description'], h2, h3, h4")?.textContent?.trim();
        if (!name || name.length < 3) continue;

        const allText = card.textContent || "";
        const priceMatch = allText.match(/€\s*(\d+)[,.](\d{2})/);
        const newPrice = priceMatch ? parseFloat(`${priceMatch[1]}.${priceMatch[2]}`) : 0;

        const oldEl = card.querySelector("s, del, [class*='before'], [class*='old'], [class*='regular']");
        const oldMatch = oldEl?.textContent?.match(/(\d+)[,.](\d{2})/);
        const originalPrice = oldMatch ? parseFloat(`${oldMatch[1]}.${oldMatch[2]}`) : newPrice;

        const badge = card.querySelector("[class*='discount'], [class*='badge'], [class*='label'], [class*='tag']")?.textContent?.trim() || "";
        const image = card.querySelector("img")?.src || card.querySelector("img")?.getAttribute("data-src") || null;

        results.push({ name, newPrice, originalPrice, badge, image });
      }
      return results;
    });

    console.log("[Lidl] HTML found:", products.length, "products");
    return products.slice(0, maxResults).map((p, i) => {
      const savings = p.originalPrice > p.newPrice && p.newPrice > 0 ? Math.round((1 - p.newPrice / p.originalPrice) * 100) : 0;
      return {
        id: 4000 + i,
        store: "Lidl", storeColor: "#0050AA", storeLogo: "L",
        item: p.name,
        deal: p.badge || (savings > 0 ? `-${savings}%` : "Aanbieding"),
        category: "Overig",
        originalPrice: p.originalPrice, newPrice: p.newPrice, savings,
        emoji: "🛒", validUntil: dutchDate(7), hot: savings >= 30,
        description: "", image: p.image,
      };
    });
  } finally {
    await page.close();
  }
}

module.exports = { scrapeLidl };
