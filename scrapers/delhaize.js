// Delhaize Belgium — Playwright scraper
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
  const map = {
    "dranken": "🥤", "zuivel": "🥛", "vlees": "🥩", "brood": "🍞",
    "diepvries": "🧊", "groenten": "🥦", "fruit": "🍎", "koeken": "🍫",
    "chocolade": "🍫", "wijn": "🍷", "bier": "🍺", "snacks": "🍿",
    "kaas": "🧀", "charcuterie": "🥓",
  };
  if (!cat) return "🛒";
  const lower = cat.toLowerCase();
  for (const [key, emoji] of Object.entries(map)) {
    if (lower.includes(key)) return emoji;
  }
  return "🛒";
}

async function scrapeDelhaize(browser, maxResults = 15) {
  const page = await browser.newPage();
  try {
    await page.setExtraHTTPHeaders({ "Accept-Language": "nl-BE,nl;q=0.9" });

    // Intercept API responses
    const apiData = [];
    page.on("response", async (response) => {
      const url = response.url();
      if ((url.includes("api") || url.includes("product") || url.includes("promo")) &&
          response.headers()["content-type"]?.includes("application/json")) {
        try {
          const json = await response.json();
          apiData.push({ url, json });
        } catch { /* not JSON */ }
      }
    });

    await page.goto("https://www.delhaize.be/nl/promoties", { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForTimeout(3000); // let XHR/fetch calls happen

    // Check if any API calls returned useful data
    for (const { json } of apiData) {
      const items = json.results || json.products || json.items || json.data?.products || [];
      if (items.length > 0) {
        return items.slice(0, maxResults).map((p, i) => {
          const orig = p.price?.value || p.regularPrice || p.originalPrice || 0;
          const curr = p.promoPrice?.value || p.promotionPrice || p.discountedPrice || orig;
          const savings = orig > curr ? Math.round((1 - curr / orig) * 100) : 0;
          return {
            id: 5000 + i,
            store: "Delhaize", storeColor: "#E4002B", storeLogo: "D",
            item: p.name || p.productName || "Onbekend",
            deal: savings > 0 ? `-${savings}%` : (p.promotionDescription || "Promo"),
            category: p.categories?.[0]?.name || p.categoryName || "Overig",
            originalPrice: orig, newPrice: curr, savings,
            emoji: categoryToEmoji(p.categories?.[0]?.name || p.categoryName),
            validUntil: isoToDutch(p.promotionEndDate || p.endDate),
            hot: savings >= 30,
            description: p.description || p.summary || "",
            image: p.images?.[0]?.url || p.imageUrl || null,
          };
        });
      }
    }

    // Try Next.js embedded data
    const nextData = await page.evaluate(() => {
      const el = document.getElementById("__NEXT_DATA__");
      return el ? el.textContent : null;
    });

    if (nextData) {
      try {
        const parsed = JSON.parse(nextData);
        const props = parsed?.props?.pageProps || {};
        const items = props.products || props.promotions || props.data?.products || [];
        if (items.length > 0) {
          return items.slice(0, maxResults).map((p, i) => ({
            id: 5000 + i,
            store: "Delhaize", storeColor: "#E4002B", storeLogo: "D",
            item: p.name || "Onbekend",
            deal: p.promotionDescription || "Promo",
            category: p.categoryName || "Overig",
            originalPrice: p.regularPrice || 0,
            newPrice: p.promotionPrice || p.price || 0,
            savings: 0,
            emoji: "🛒",
            validUntil: isoToDutch(p.endDate),
            hot: false,
            description: p.description || "",
            image: p.imageUrl || null,
          }));
        }
      } catch { /* continue */ }
    }

    // Scrape product cards from HTML
    const products = await page.evaluate(() => {
      const results = [];
      const selectors = [
        "[data-testid='product-card']",
        "[class*='ProductCard']",
        "[class*='product-card']",
        "[class*='PromotionCard']",
        "[class*='promotion-card']",
        ".product-tile",
        "[class*='product-tile']",
      ];

      let cards = [];
      for (const sel of selectors) {
        cards = Array.from(document.querySelectorAll(sel));
        if (cards.length > 0) break;
      }

      for (const card of cards.slice(0, 25)) {
        const name = card.querySelector("[class*='name'], [class*='title'], h2, h3, p")?.textContent?.trim();
        if (!name || name.length < 3) continue;

        const priceEls = card.querySelectorAll("[class*='price'], [class*='Price']");
        let newPrice = 0, originalPrice = 0;
        for (const el of priceEls) {
          const text = el.textContent || "";
          const match = text.match(/(\d+)[,.](\d{2})/);
          if (match) {
            const val = parseFloat(`${match[1]}.${match[2]}`);
            if (el.className.includes("old") || el.className.includes("before") || el.tagName === "S") {
              originalPrice = val;
            } else if (newPrice === 0) {
              newPrice = val;
            }
          }
        }
        if (originalPrice === 0) originalPrice = newPrice;

        const image = card.querySelector("img")?.src || null;
        const badge = card.querySelector("[class*='badge'], [class*='promotion'], [class*='label']")?.textContent?.trim() || "";

        results.push({ name, newPrice, originalPrice, badge, image });
      }
      return results;
    });

    return products.slice(0, maxResults).map((p, i) => {
      const savings = p.originalPrice > p.newPrice && p.newPrice > 0
        ? Math.round((1 - p.newPrice / p.originalPrice) * 100) : 0;
      return {
        id: 5000 + i,
        store: "Delhaize", storeColor: "#E4002B", storeLogo: "D",
        item: p.name,
        deal: p.badge || (savings > 0 ? `-${savings}%` : "Promo"),
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

module.exports = { scrapeDelhaize };
