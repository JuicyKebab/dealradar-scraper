// Carrefour Belgium — Playwright scraper
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
  };
  if (!cat) return "🛒";
  const lower = cat.toLowerCase();
  for (const [key, emoji] of Object.entries(map)) {
    if (lower.includes(key)) return emoji;
  }
  return "🛒";
}

async function scrapeCarrefour(browser, maxResults = 15) {
  const page = await browser.newPage();
  try {
    await page.setExtraHTTPHeaders({
      "Accept-Language": "nl-BE,nl;q=0.9,en;q=0.8",
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
      "Accept-Encoding": "gzip, deflate, br",
      "sec-ch-ua": '"Chromium";v="122", "Not(A:Brand";v="24", "Google Chrome";v="122"',
      "sec-ch-ua-mobile": "?0",
      "sec-ch-ua-platform": '"Windows"',
      "Sec-Fetch-Dest": "document",
      "Sec-Fetch-Mode": "navigate",
      "Sec-Fetch-Site": "none",
      "Sec-Fetch-User": "?1",
      "Upgrade-Insecure-Requests": "1",
    });
    // Set a realistic viewport
    await page.setViewportSize({ width: 1280, height: 800 });

    // Intercept API responses
    const apiData = [];
    page.on("response", async (response) => {
      const url = response.url();
      if (url.includes("product") || url.includes("promo") || url.includes("offer") || url.includes("catalog")) {
        const ct = response.headers()["content-type"] || "";
        if (ct.includes("application/json")) {
          try {
            const json = await response.json();
            apiData.push({ url, json });
          } catch { /* not JSON */ }
        }
      }
    });

    const response = await page.goto("https://www.carrefour.be/nl/acties", { waitUntil: "domcontentloaded", timeout: 30000 });
    // Cloudflare challenge detection
    if (response?.status() === 403 || response?.status() === 503) {
      console.log("[Carrefour] Blocked by Cloudflare, status:", response.status());
      return [];
    }
    await page.waitForTimeout(4000);

    // Accept cookie consent if present
    try {
      await page.waitForSelector("button:has-text('Alles accepteren'), button:has-text('Accepteer'), #onetrust-accept-btn-handler", { timeout: 5000 });
      await page.click("button:has-text('Alles accepteren'), button:has-text('Accepteer'), #onetrust-accept-btn-handler");
      console.log("[Carrefour] Cookie banner accepted");
      await page.waitForTimeout(2000);
    } catch { /* no banner */ }

    // Check API responses
    for (const { json } of apiData) {
      const items = json.results || json.products || json.hits || json.items || json.data?.products || [];
      if (items.length > 3) {
        return items.slice(0, maxResults).map((p, i) => {
          const orig = p.regularPrice || p.originalPrice || p.listPrice || p.price?.regular || 0;
          const curr = p.salePrice || p.promotionPrice || p.price?.sale || p.price?.current || orig;
          const savings = orig > curr ? Math.round((1 - curr / orig) * 100) : 0;
          return {
            id: 6000 + i,
            store: "Carrefour", storeColor: "#004F9F", storeLogo: "CF",
            item: p.name || p.title || "Onbekend",
            deal: savings > 0 ? `-${savings}%` : (p.promotionLabel || "Promo"),
            category: p.category || p.department || "Overig",
            originalPrice: orig, newPrice: curr, savings,
            emoji: categoryToEmoji(p.category || p.department),
            validUntil: isoToDutch(p.endDate || p.promotionEndDate || p.validTo),
            hot: savings >= 30,
            description: p.description || "",
            image: p.image || p.imageUrl || p.thumbnail || null,
          };
        });
      }
    }

    // Try Next.js/React embedded data
    const jsData = await page.evaluate(() => {
      const nextEl = document.getElementById("__NEXT_DATA__");
      if (nextEl) return nextEl.textContent;
      // Gatsby
      const gatsbyEl = document.getElementById("gatsby-state");
      if (gatsbyEl) return gatsbyEl.textContent;
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
            id: 6000 + i,
            store: "Carrefour", storeColor: "#004F9F", storeLogo: "CF",
            item: p.name || p.title || "Onbekend",
            deal: "Promo",
            category: p.category || "Overig",
            originalPrice: p.regularPrice || p.price || 0,
            newPrice: p.salePrice || p.price || 0,
            savings: 0,
            emoji: categoryToEmoji(p.category),
            validUntil: dutchDate(7),
            hot: false,
            description: p.description || "",
            image: p.image || p.imageUrl || null,
          }));
        }
      } catch { /* continue */ }
    }

    // HTML scraping fallback
    const products = await page.evaluate(() => {
      const results = [];
      const selectors = [
        "[data-testid='product-card']",
        "[class*='ProductCard']",
        "[class*='product-card']",
        "[class*='ProductTile']",
        "[class*='PromotionCard']",
        ".product-item",
      ];

      let cards = [];
      for (const sel of selectors) {
        cards = Array.from(document.querySelectorAll(sel));
        if (cards.length > 0) break;
      }

      for (const card of cards.slice(0, 25)) {
        const name = card.querySelector("[class*='name'], [class*='title'], [class*='description'], h2, h3")?.textContent?.trim();
        if (!name || name.length < 3) continue;

        let newPrice = 0, originalPrice = 0;
        const priceEls = card.querySelectorAll("[class*='price'], [class*='Price']");
        for (const el of priceEls) {
          const match = el.textContent.match(/(\d+)[,.](\d{2})/);
          if (match) {
            const val = parseFloat(`${match[1]}.${match[2]}`);
            if (el.tagName === "S" || el.className.includes("old") || el.className.includes("before")) {
              originalPrice = val;
            } else if (newPrice === 0) {
              newPrice = val;
            }
          }
        }
        if (originalPrice === 0) originalPrice = newPrice;

        const image = card.querySelector("img")?.src || null;
        const badge = card.querySelector("[class*='badge'], [class*='discount'], [class*='promo']")?.textContent?.trim() || "";
        results.push({ name, newPrice, originalPrice, badge, image });
      }
      return results;
    });

    return products.slice(0, maxResults).map((p, i) => {
      const savings = p.originalPrice > p.newPrice && p.newPrice > 0
        ? Math.round((1 - p.newPrice / p.originalPrice) * 100) : 0;
      return {
        id: 6000 + i,
        store: "Carrefour", storeColor: "#004F9F", storeLogo: "CF",
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

module.exports = { scrapeCarrefour };
