// Albert Heijn — Playwright + RSC/API intercept
// AH gebruikt Next.js App Router: data komt via text/x-component stream (RSC)
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
  const map = { "dranken": "🥤", "zuivel": "🥛", "vlees": "🥩", "brood": "🍞", "diepvries": "🧊", "groenten": "🥦", "fruit": "🍎", "koeken": "🍫", "wijn": "🍷", "bier": "🍺", "kaas": "🧀" };
  if (!cat) return "🛒";
  const lower = cat.toLowerCase();
  for (const [key, emoji] of Object.entries(map)) { if (lower.includes(key)) return emoji; }
  return "🛒";
}

function mapAH(p, i) {
  const curr = p.priceLabel?.now?.amount ?? p.currentPrice?.amount ?? p.price?.now ?? p.price ?? 0;
  const prev = p.priceLabel?.was?.amount ?? p.priceBeforeBonus?.amount ?? p.price?.was ?? curr;
  const savings = prev > curr && curr > 0 ? Math.round((1 - curr / prev) * 100) : 0;
  const dealText = p.bonusMechanism || p.promotionType || p.shield?.text || (savings > 0 ? `-${savings}%` : "Bonus");
  return {
    id: 3000 + i,
    store: "Albert Heijn", storeColor: "#00A0E2", storeLogo: "AH",
    item: p.title || p.description || p.name || p.productName || "Onbekend",
    deal: dealText,
    category: p.mainCategory || p.subCategory || p.category || "Overig",
    originalPrice: prev, newPrice: curr, savings,
    emoji: categoryToEmoji(p.mainCategory || p.subCategory),
    validUntil: isoToDutch(p.bonusEndDate || p.endDate),
    hot: savings >= 30,
    description: p.descriptionHighlights?.join(", ") || "",
    image: p.images?.[0]?.url || p.imageUrl || null,
  };
}

// Zoek recursief naar product-arrays in een object
function findProductArrays(obj, depth = 0, found = []) {
  if (depth > 8 || !obj || typeof obj !== "object") return found;
  if (Array.isArray(obj)) {
    if (obj.length >= 3 && obj[0] && typeof obj[0] === "object"
        && (obj[0].title || obj[0].description || obj[0].name || obj[0].productName)) {
      found.push(obj);
    }
    obj.forEach(item => findProductArrays(item, depth + 1, found));
  } else {
    for (const val of Object.values(obj)) findProductArrays(val, depth + 1, found);
  }
  return found;
}

// Parse RSC (React Server Components) payload - text/x-component formaat
// Elke regel is: <id>:<JSON> of <id>:["$","elementType",...]
function parseRscPayload(text) {
  const products = [];
  const lines = text.split("\n");
  for (const line of lines) {
    const colonIdx = line.indexOf(":");
    if (colonIdx < 0) continue;
    const content = line.slice(colonIdx + 1).trim();
    if (!content.startsWith("{") && !content.startsWith("[")) continue;
    try {
      const parsed = JSON.parse(content);
      const arrays = findProductArrays(parsed);
      for (const arr of arrays) {
        products.push(...arr);
      }
    } catch { /* ongeldige JSON, skip */ }
  }
  return products;
}

async function scrapeAlbertHeijn(browser, maxResults = 200) {
  const page = await browser.newPage();
  try {
    await page.setExtraHTTPHeaders({
      "Accept-Language": "nl-NL,nl;q=0.9",
      "sec-ch-ua": '"Chromium";v="122", "Not(A:Brand";v="24", "Google Chrome";v="122"',
      "sec-ch-ua-mobile": "?0",
      "sec-ch-ua-platform": '"Windows"',
    });
    await page.setViewportSize({ width: 1280, height: 800 });

    const products = [];
    const rscBuffers = {};

    // Intercept JSON API responses
    page.on("response", async (response) => {
      const url = response.url();
      const ct = response.headers()["content-type"] || "";

      // JSON API responses
      if (ct.includes("application/json") && (url.includes("ah.nl") || url.includes("appie"))) {
        try {
          const json = await response.json();
          console.log(`[AH] JSON from ${url.slice(0, 100)}`);
          const candidates = [
            json.products,
            json.cards?.flatMap(c => c.products || []),
            json.lanes?.flatMap(l => l.products || l.items || []),
            json.results,
            Array.isArray(json) ? json : null,
          ].filter(a => Array.isArray(a) && a.length > 0 && (a[0]?.title || a[0]?.name || a[0]?.description));
          for (const arr of candidates) {
            console.log(`[AH] JSON: ${arr.length} products`);
            products.push(...arr);
          }
        } catch { /* skip */ }
      }

      // RSC stream (text/x-component) — Next.js App Router data
      if (ct.includes("text/x-component") || ct.includes("text/html") && url.includes("_rsc")) {
        try {
          const text = await response.text();
          if (text.length > 100) {
            console.log(`[AH] RSC payload: ${text.length} bytes from ${url.slice(0, 100)}`);
            const found = parseRscPayload(text);
            if (found.length > 0) {
              console.log(`[AH] RSC: ${found.length} products gevonden`);
              products.push(...found);
            }
          }
        } catch { /* skip */ }
      }
    });

    await page.goto("https://www.ah.nl/bonus", { waitUntil: "domcontentloaded", timeout: 30000 });

    // Cookie banner accepteren
    for (const sel of [
      "[data-testhook='accept-cookies']",
      "button:has-text('Alles accepteren')",
      "button:has-text('Accepteer alles')",
      "#didomi-notice-agree-button",
    ]) {
      try {
        await page.waitForSelector(sel, { timeout: 3000 });
        await page.click(sel);
        console.log("[AH] Cookie banner geaccepteerd");
        break;
      } catch { /* probeer volgende */ }
    }

    // Wacht op echte content (niet skeletons)
    await page.waitForTimeout(5000);

    // Scroll om lazy loading te triggeren
    for (let i = 1; i <= 8; i++) {
      await page.evaluate((p) => window.scrollTo(0, document.body.scrollHeight * p), i / 8);
      await page.waitForTimeout(1000);
    }
    await page.waitForTimeout(5000);

    // Probeer ook HTML parsing als API-intercept niets opleverde
    if (products.length === 0) {
      console.log("[AH] Geen API data, probeer HTML parsing...");
      const htmlProducts = await page.evaluate(() => {
        const results = [];
        // Probeer product cards te vinden
        const selectors = [
          "[data-testhook='product-card']",
          "[class*='product-card']",
          "[class*='ProductCard']",
          "[class*='bonus-product']",
          "article[class*='product']",
          "[data-testid*='product']",
        ];
        let cards = [];
        for (const sel of selectors) {
          cards = Array.from(document.querySelectorAll(sel));
          if (cards.length > 3) {
            console.log("AH selector:", sel, cards.length);
            break;
          }
        }
        for (const card of cards) {
          const title = card.querySelector("[class*='title'], [class*='name'], h3, h2")?.textContent?.trim();
          if (!title || title.length < 2) continue;
          const priceEl = card.querySelector("[class*='price'], [data-testhook*='price']");
          const priceText = priceEl?.textContent?.replace(",", ".") || "0";
          const priceMatch = priceText.match(/(\d+)[.,](\d{2})/);
          const price = priceMatch ? parseFloat(`${priceMatch[1]}.${priceMatch[2]}`) : 0;
          const img = card.querySelector("img")?.src || null;
          const deal = card.querySelector("[class*='shield'], [class*='badge'], [class*='discount']")?.textContent?.trim() || "Bonus";
          results.push({ title, price, img, deal });
        }
        return results;
      });
      if (htmlProducts.length > 0) {
        console.log(`[AH] HTML: ${htmlProducts.length} producten gevonden`);
        return htmlProducts.slice(0, maxResults).map((p, i) => ({
          id: 3000 + i,
          store: "Albert Heijn", storeColor: "#00A0E2", storeLogo: "AH",
          item: p.title,
          deal: p.deal,
          category: "Overig",
          originalPrice: p.price,
          newPrice: p.price,
          savings: 0,
          emoji: "🛒",
          validUntil: dutchDate(7),
          hot: false,
          description: "",
          image: p.img,
        }));
      }
    }

    // Dedupliceer op basis van titel
    const unique = products.filter((p, i, arr) =>
      arr.findIndex(x => (x.id || x.webshopId || x.title || x.description) === (p.id || p.webshopId || p.title || p.description)) === i
    );
    console.log(`[AH] Totaal uniek: ${unique.length} producten`);
    return unique.slice(0, maxResults).map(mapAH);
  } finally {
    await page.close();
  }
}

module.exports = { scrapeAlbertHeijn };
