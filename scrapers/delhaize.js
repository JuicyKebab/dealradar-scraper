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

// Recursively search a JSON object for arrays that look like product lists
function findProducts(obj, depth = 0) {
  if (depth > 5 || !obj || typeof obj !== "object") return null;
  if (Array.isArray(obj)) {
    if (obj.length > 0 && (obj[0]?.name || obj[0]?.productName || obj[0]?.title)) return obj;
    return null;
  }
  for (const val of Object.values(obj)) {
    const found = findProducts(val, depth + 1);
    if (found) return found;
  }
  return null;
}

async function scrapeDelhaize(browser, maxResults = 15) {
  const page = await browser.newPage();
  try {
    await page.setExtraHTTPHeaders({ "Accept-Language": "nl-BE,nl;q=0.9" });

    // Intercept ALL JSON responses
    const apiProducts = [];
    page.on("response", async (response) => {
      const ct = response.headers()["content-type"] || "";
      if (!ct.includes("application/json")) return;
      try {
        const json = await response.json();
        const url = response.url();

        // Delhaize GraphQL: data.products / data.promotions / data.promotionPage.products etc.
        const candidates = [
          json.results,
          json.products,
          json.items,
          json.data?.products,
          json.data?.promotions,
          json.data?.promotionProducts,
          json.data?.promotionPage?.products,
          json.data?.promotionPage?.items,
          json.data?.searchProducts?.results,
          json.data?.promotedProducts,
          json.data?.catalog?.products,
        ].filter(a => Array.isArray(a) && a.length > 2 && (a[0]?.name || a[0]?.title || a[0]?.productName)
          && typeof (a[0]?.name || a[0]?.title || a[0]?.productName) === "string"
          && (a[0]?.name || a[0]?.title || a[0]?.productName).length < 200);

        if (candidates.length > 0) {
          console.log("[Delhaize] Found products in", url.slice(0, 80), "count:", candidates[0].length);
          apiProducts.push(...candidates[0]);
          return;
        }

        // Deep search as fallback
        const found = findProducts(json);
        if (found && found.length > 2) {
          console.log("[Delhaize] Deep-found products in", url.slice(0, 80), "count:", found.length);
          apiProducts.push(...found);
        }
      } catch { /* skip */ }
    });

    await page.goto("https://www.delhaize.be/nl/promoties", { waitUntil: "domcontentloaded", timeout: 45000 });

    // Accept cookie consent — blocks GraphQL product queries if not dismissed
    try {
      const cookieSelectors = [
        "#didomi-notice-agree-button",
        "[data-didomi-action='agree-to-all']",
        "button:has-text('Alles accepteren')",
        "button:has-text('Accepteer alles')",
        "button:has-text('Tout accepter')",
        "button:has-text('Akkoord')",
        "[class*='acceptAll']",
        "[class*='accept-all']",
        "[data-testid*='accept']",
      ];
      await page.waitForSelector(cookieSelectors.join(", "), { timeout: 6000 });
      await page.click(cookieSelectors.join(", "));
      console.log("[Delhaize] Cookie banner accepted");
      await page.waitForTimeout(3000);
    } catch { /* no banner or already accepted */ }

    // Scroll to trigger lazy loading and wait for React to load products
    await page.waitForTimeout(4000);
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight / 2));
    await page.waitForTimeout(3000);
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(3000);

    if (apiProducts.length > 0) {
      console.log("[Delhaize] Total API products:", apiProducts.length);
      const unique = apiProducts.filter((p, i, arr) =>
        arr.findIndex(x => (x.id || x.productId || x.ean) === (p.id || p.productId || p.ean)) === i
      );
      return unique.slice(0, maxResults).map((p, i) => {
        const orig = p.price?.regularPrice || p.price?.value || p.regularPrice || p.originalPrice || 0;
        const curr = p.price?.promotionPrice || p.promoPrice?.value || p.promotionPrice || p.discountedPrice || orig;
        const savings = orig > curr && orig > 0 ? Math.round((1 - curr / orig) * 100) : 0;
        return {
          id: 5000 + i,
          store: "Delhaize", storeColor: "#E4002B", storeLogo: "D",
          item: p.name || p.productName || p.title || "Onbekend",
          deal: savings > 0 ? `-${savings}%` : (p.promotionDescription || p.promoText || "Promo"),
          category: p.categories?.[0]?.name || p.topCategory || p.categoryName || "Overig",
          originalPrice: orig, newPrice: curr, savings,
          emoji: categoryToEmoji(p.categories?.[0]?.name || p.categoryName),
          validUntil: isoToDutch(p.promotionEndDate || p.endDate || p.validUntilDate),
          hot: savings >= 30,
          description: p.description || p.summary || "",
          image: p.images?.[0]?.url || p.imageUrl || p.thumbnail || null,
        };
      });
    }

    // HTML fallback — styled-components uses hashed class names, use data-testid
    const products = await page.evaluate(() => {
      const results = [];
      const selectors = [
        "[data-testid='product-card']",
        "[data-testid*='product']",
        "[data-testid*='promotion']",
        "[data-stellar*='product']",
        "[class*='ProductCard']",
        "[class*='product-card']",
        "[class*='PromotionCard']",
        ".product-tile",
      ];

      let cards = [];
      for (const sel of selectors) {
        cards = Array.from(document.querySelectorAll(sel));
        if (cards.length > 2) break;
      }
      console.log("Delhaize HTML cards found:", cards.length);

      for (const card of cards.slice(0, 25)) {
        const name = card.querySelector("[data-testid*='name'], [data-testid*='title'], h2, h3, p")?.textContent?.trim();
        if (!name || name.length < 3) continue;

        const allText = card.textContent || "";
        const prices = [...allText.matchAll(/€\s*(\d+)[,.](\d{2})/g)].map(m => parseFloat(`${m[1]}.${m[2]}`));
        const newPrice = prices.length > 0 ? Math.min(...prices) : 0;
        const originalPrice = prices.length > 1 ? Math.max(...prices) : newPrice;

        const badge = card.querySelector("[data-testid*='badge'], [data-testid*='promo'], [class*='badge']")?.textContent?.trim() || "";
        const image = card.querySelector("img")?.src || null;

        results.push({ name, newPrice, originalPrice, badge, image });
      }
      return results;
    });

    console.log("[Delhaize] HTML found:", products.length, "products");
    return products.slice(0, maxResults).map((p, i) => {
      const savings = p.originalPrice > p.newPrice && p.newPrice > 0
        ? Math.round((1 - p.newPrice / p.originalPrice) * 100) : 0;
      return {
        id: 5000 + i,
        store: "Delhaize", storeColor: "#E4002B", storeLogo: "D",
        item: p.name,
        deal: p.badge || (savings > 0 ? `-${savings}%` : "Promo"),
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

module.exports = { scrapeDelhaize };
