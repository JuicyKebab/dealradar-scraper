// Lidl Belgium — intercept search API via stealth Playwright
const _DDAYS = ["zo", "ma", "di", "wo", "do", "vr", "za"];
const _DMONTHS = ["januari", "februari", "maart", "april", "mei", "juni", "juli", "augustus", "september", "oktober", "november", "december"];

function dutchDate(daysFromNow = 7) {
  const d = new Date();
  d.setDate(d.getDate() + daysFromNow);
  return `${_DDAYS[d.getDay()]} ${d.getDate()} ${_DMONTHS[d.getMonth()]}`;
}
function unixToDutch(ts) {
  if (!ts) return dutchDate(7);
  const d = new Date(ts * 1000);
  if (isNaN(d)) return dutchDate(7);
  return `${_DDAYS[d.getDay()]} ${d.getDate()} ${_DMONTHS[d.getMonth()]}`;
}
function categoryToEmoji(cat) {
  const map = { "dranken": "🥤", "zuivel": "🥛", "vlees": "🥩", "brood": "🍞", "diepvries": "🧊", "groenten": "🥦", "fruit": "🍎", "koeken": "🍫", "wijn": "🍷", "bier": "🍺" };
  if (!cat) return "🛒";
  const lower = cat.toLowerCase();
  for (const [key, emoji] of Object.entries(map)) { if (lower.includes(key)) return emoji; }
  return "🛒";
}

function mapItem(item, i) {
  const d = item.gridbox?.data || item;
  const priceObj = d.price || {};
  const curr = priceObj.price ?? 0;
  const orig = priceObj.oldPrice ?? priceObj.discount?.deletedPrice ?? curr;
  const savings = priceObj.discount?.percentageDiscount ?? (orig > curr && curr > 0 ? Math.round((1 - curr / orig) * 100) : 0);
  return {
    id: 4000 + i,
    store: "Lidl", storeColor: "#0050AA", storeLogo: "L",
    item: d.fullTitle || d.title || "Onbekend",
    deal: savings > 0 ? `-${savings}%` : (d.promotionText || "Aanbieding"),
    category: d.category || "Overig",
    originalPrice: orig, newPrice: curr, savings,
    emoji: categoryToEmoji(d.category),
    validUntil: unixToDutch(d.storeEndDate || d.stockAvailability?.badgeInfoV2?.[0]?.validUntil),
    hot: savings >= 30,
    description: d.keyfacts?.features?.[0] || "",
    image: d.image || d.imageList?.[0] || null,
  };
}

async function scrapeLidl(browser, maxResults = 1000) {
  const page = await browser.newPage();
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => false });
    window.chrome = { runtime: {} };
    Object.defineProperty(navigator, "plugins", { get: () => [1, 2, 3] });
    Object.defineProperty(navigator, "languages", { get: () => ["nl-BE", "nl", "fr"] });
  });
  try {
    await page.setExtraHTTPHeaders({ "Accept-Language": "nl-BE,nl;q=0.9" });

    let cookieAccepted = false;
    const intercepted = [];
    page.on("response", async (response) => {
      if (!cookieAccepted) return; // Negeer responses vóór cookie accept (lege resultaten)
      const url = response.url();
      const ct = response.headers()["content-type"] || "";
      if (!url.includes("lidl.be/q/api") && !ct.includes("mindshift")) return;
      try {
        const text = await response.text();
        const json = JSON.parse(text);
        if (json.items?.length > 0) {
          console.log(`[Lidl] Intercepted: ${url.slice(0, 80)} -> ${json.items.length} items (numFound: ${json.numFound})`);
          intercepted.push(...json.items);
        }
      } catch { /* skip */ }
    });

    await page.goto("https://www.lidl.be/q/nl-BE/query/promo", { waitUntil: "domcontentloaded", timeout: 45000 });
    try {
      await page.waitForSelector("#onetrust-accept-btn-handler", { timeout: 8000 });
      await page.click("#onetrust-accept-btn-handler");
      console.log("[Lidl] Cookie geaccepteerd");
    } catch { /* geen banner */ }
    cookieAccepted = true;

    // Wacht even zodat pagina herlaadt na cookie accept, dan op search API
    await page.waitForTimeout(3000);
    try {
      await page.waitForResponse(
        r => r.url().includes("lidl.be/q/api") && r.status() === 200,
        { timeout: 25000 }
      );
    } catch { console.log("[Lidl] Search API timeout"); }

    // Extra scroll voor paginering
    await page.waitForTimeout(2000);
    for (let i = 1; i <= 4; i++) {
      await page.evaluate((p) => window.scrollTo(0, document.body.scrollHeight * p), i / 4);
      await page.waitForTimeout(1500);
    }
    await page.waitForTimeout(3000);

    console.log(`[Lidl] Totaal intercepted: ${intercepted.length}`);
    if (intercepted.length > 0) return intercepted.slice(0, maxResults).map(mapItem);

    console.log("[Lidl] Geen API-data, geef leeg terug");
    return [];
  } finally {
    await page.close();
  }
}

module.exports = { scrapeLidl };
