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

const LIDL_SITEMAP = "https://www.lidl.be/explore/assets/s/pages_nl-BE_be.xml.gz";
const LIDL_FALLBACK_URL = "https://www.lidl.be/c/nl-BE/aanbiedingen-deze-week/a10082242";

async function getLidlPromoUrl() {
  try {
    const zlib = require("zlib");
    const https = require("https");
    const xml = await new Promise((resolve, reject) => {
      https.get(LIDL_SITEMAP, res => {
        const chunks = [];
        res.on("data", c => chunks.push(c));
        res.on("end", () => {
          zlib.gunzip(Buffer.concat(chunks), (err, buf) => {
            if (err) reject(err);
            else resolve(buf.toString());
          });
        });
      }).on("error", reject);
    });
    const matches = [...xml.matchAll(/https:\/\/www\.lidl\.be\/c\/nl-BE\/aanbiedingen-deze-week\/[^<"]+/g)];
    if (matches.length > 0) {
      const url = matches[matches.length - 1][0]; // neem de laatste (meest recente)
      console.log("[Lidl] Promo URL uit sitemap:", url);
      return url;
    }
  } catch (e) {
    console.log("[Lidl] Sitemap ophalen mislukt:", e.message);
  }
  return LIDL_FALLBACK_URL;
}

function getPrice(v) {
  if (typeof v === "number") return v;
  if (v && typeof v === "object") return v.price || v.amount || v.value || 0;
  return parseFloat(v) || 0;
}

function mapLidlProduct(p, i) {
  const curr = getPrice(p.price) || getPrice(p.currentPrice) || getPrice(p.promotionPrice) || 0;
  const orig = getPrice(p.regularPrice) || getPrice(p.originalPrice) || getPrice(p.fullPrice)
    || getPrice(p.price?.regular) || getPrice(p.wasPrice) || getPrice(p.normalPrice)
    || getPrice(p.basePrice) || curr;
  const savings = orig > curr && curr > 0 ? Math.round((1 - curr / orig) * 100) : 0;
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
}

async function scrapeLidl(browser, maxResults = 100) {
  const page = await browser.newPage();
  try {
    await page.setExtraHTTPHeaders({ "Accept-Language": "nl-BE,nl;q=0.9" });

    // Intercept API responses — useful if the SSR page also fires XHR for additional pages
    const apiProducts = [];
    page.on("response", async (response) => {
      const ct = response.headers()["content-type"] || "";
      if (!ct.includes("application/json")) return;
      try {
        const json = await response.json();
        const items = json.products || json.results || json.hits || json.items
          || json.data?.products || json.data?.results || json.offers
          || (Array.isArray(json) ? json : null) || [];
        if (items.length > 2 && (items[0]?.name || items[0]?.title || items[0]?.fullTitle)) {
          console.log("[Lidl] JSON intercept:", response.url().slice(0, 80), "->", items.length);
          apiProducts.push(...items);
        }
      } catch { /* skip */ }
    });

    // SPA zoekpagina — vuurt product-search API (werkt nu met EU IP via Railway Europe West)
    const promoUrl = "https://www.lidl.be/q/nl-BE/query/promo";
    await page.goto(promoUrl, { waitUntil: "domcontentloaded", timeout: 45000 });
    console.log("[Lidl] Loaded:", promoUrl);

    // Cookie banner wegklikken zodat lazy-load ook werkt
    try {
      await page.waitForSelector("#onetrust-accept-btn-handler", { timeout: 6000 });
      await page.click("#onetrust-accept-btn-handler");
      console.log("[Lidl] Cookie geaccepteerd");
    } catch { /* geen banner */ }

    // Wacht op volledige render + scroll voor lazy loading
    await page.waitForTimeout(3000);
    for (let i = 1; i <= 6; i++) {
      await page.evaluate((pct) => window.scrollTo(0, document.body.scrollHeight * pct), i / 6);
      await page.waitForTimeout(1000);
    }
    await page.waitForTimeout(2000);

    // 1. Probeer __NUXT_DATA__ — Nuxt 3 SSR state, bevat useProductStore met alle producten
    try {
      const nuxtDataText = await page.evaluate(() => document.getElementById("__NUXT_DATA__")?.textContent);
      if (nuxtDataText) {
        // Nuxt 3 devalue formaat: flat array, references by index
        // Resolve: volg integer-referenties en speciale markers
        const arr = JSON.parse(nuxtDataText);
        function resolve(idx, seen = new Set()) {
          if (idx === null || idx === undefined || typeof idx !== "number") return idx;
          if (seen.has(idx)) return null;
          seen.add(idx);
          const val = arr[idx];
          if (val === null || val === undefined || typeof val !== "object") return val;
          if (Array.isArray(val)) {
            // Speciale markers: ["ShallowReactive", n], ["Reactive", n], ["Set", ...], ["Map", ...]
            if (val[0] === "ShallowReactive" || val[0] === "Reactive") return resolve(val[1], new Set(seen));
            if (val[0] === "Set") return val.slice(1).map(i => resolve(i, new Set(seen)));
            if (val[0] === "Map") {
              const m = {};
              for (let i = 1; i < val.length; i += 2) m[resolve(val[i], new Set(seen))] = resolve(val[i + 1], new Set(seen));
              return m;
            }
            return val.map(i => (typeof i === "number" ? resolve(i, new Set(seen)) : i));
          }
          // Object: resolve all values
          const out = {};
          for (const [k, v] of Object.entries(val)) {
            out[k] = typeof v === "number" ? resolve(v, new Set(seen)) : v;
          }
          return out;
        }

        // Zoek useProductStore index in pinia state
        // Structuur: arr[0] = root, arr[1] = {pinia: N}, arr[N] = {useProductStore: M, ...}
        let productStoreIdx = null;
        for (let i = 0; i < Math.min(arr.length, 50); i++) {
          const v = arr[i];
          if (v && typeof v === "object" && !Array.isArray(v) && "useProductStore" in v) {
            productStoreIdx = v["useProductStore"];
            break;
          }
        }

        if (productStoreIdx !== null) {
          console.log("[Lidl] useProductStore index:", productStoreIdx);
          const productStore = resolve(productStoreIdx);
          console.log("[Lidl] productStore keys:", productStore ? Object.keys(productStore).slice(0, 10) : "null");

          // Zoek een array van producten in de store
          const findArr = (obj, depth = 0) => {
            if (depth > 6 || !obj || typeof obj !== "object") return null;
            if (Array.isArray(obj) && obj.length > 2 && obj[0] && typeof obj[0] === "object" &&
                (obj[0].name || obj[0].title || obj[0].fullTitle || obj[0].price !== undefined)) return obj;
            if (!Array.isArray(obj)) {
              for (const v of Object.values(obj)) {
                const found = findArr(v, depth + 1);
                if (found) return found;
              }
            }
            return null;
          };
          const products = findArr(productStore);
          if (products && products.length > 2) {
            console.log("[Lidl] __NUXT_DATA__ products:", products.length);
            return products.slice(0, maxResults).map(mapLidlProduct);
          }
          console.log("[Lidl] productStore geladen maar geen producten-array gevonden");
        } else {
          console.log("[Lidl] useProductStore niet gevonden in __NUXT_DATA__");
        }
      }
    } catch (e) { console.log("[Lidl] __NUXT_DATA__ fout:", e.message); }

    // 2. API intercepts (voor als de pagina toch XHR gebruikt)
    if (apiProducts.length > 0) {
      console.log("[Lidl] API intercept:", apiProducts.length, "products");
      return apiProducts.slice(0, maxResults).map(mapLidlProduct);
    }

    // 3. Log page info for debugging
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
