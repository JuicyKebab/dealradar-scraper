const crypto = require("crypto");

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_ANON_KEY;

const HEADERS = {
  "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
  "Accept-Language": "nl-BE,nl;q=0.9",
};

const _DAYS = ["zo", "ma", "di", "wo", "do", "vr", "za"];
const _MONTHS = ["januari", "februari", "maart", "april", "mei", "juni",
  "juli", "augustus", "september", "oktober", "november", "december"];

function dutchDate(daysFromNow = 7) {
  const d = new Date();
  d.setDate(d.getDate() + daysFromNow);
  return `${_DAYS[d.getDay()]} ${d.getDate()} ${_MONTHS[d.getMonth()]}`;
}

function parseEndDate(text) {
  if (!text) return dutchDate(7);
  const t = text.trim().toLowerCase();
  const named = t.match(/(\d{1,2})\s+(januari|februari|maart|april|mei|juni|juli|augustus|september|oktober|november|december)/);
  if (named) {
    const day = parseInt(named[1]);
    const m = _MONTHS.indexOf(named[2]);
    const now = new Date();
    const d = new Date(now.getFullYear(), m, day);
    if (d < now && (now - d) > 30 * 86400000) d.setFullYear(now.getFullYear() + 1);
    return `${_DAYS[d.getDay()]} ${day} ${_MONTHS[m]}`;
  }
  const slashed = t.match(/(\d{1,2})[\/\-](\d{1,2})/);
  if (slashed) {
    const day = parseInt(slashed[1]);
    const m = parseInt(slashed[2]) - 1;
    const now = new Date();
    const d = new Date(now.getFullYear(), m, day);
    if (d < now && (now - d) > 30 * 86400000) d.setFullYear(now.getFullYear() + 1);
    return `${_DAYS[d.getDay()]} ${day} ${_MONTHS[m]}`;
  }
  return dutchDate(7);
}

function stableId(storeId, name) {
  const hash = crypto.createHash("md5").update(name || "").digest("hex").slice(0, 8);
  return `renmans-${storeId}-${hash}`;
}

function inferCategory(name) {
  if (!name) return "Vlees & Vis";
  const n = name.toLowerCase();
  if (n.includes("kaas") || n.includes("fromage")) return "Zuivel";
  if (n.includes("wijn") || n.includes("bier")) return "Dranken";
  return "Vlees & Vis";
}

function parsePrice(text) {
  if (!text) return 0;
  const m = text.replace(",", ".").match(/(\d+\.?\d*)/);
  return m ? parseFloat(m[1]) : 0;
}

async function getStoreList() {
  const res = await fetch("https://www.renmans.be/nl/promoties", { headers: HEADERS });
  if (!res.ok) throw new Error(`Renmans store list ${res.status}`);
  const html = await res.text();
  const match = html.match(/<script[^>]+data-drupal-selector="drupal-settings-json"[^>]*>([^<]+)<\/script>/);
  if (!match) throw new Error("Drupal settings niet gevonden");
  const settings = JSON.parse(match[1]);
  const stores = settings.stores?.stores;
  if (!Array.isArray(stores) || stores.length === 0) throw new Error("Geen winkels in Drupal settings");
  return stores.map(s => {
    const idMatch = s.link?.match(/\/define-shop\/(\d+)\//);
    return {
      id: idMatch?.[1] || null,
      city: (s.city || s.title || "").toUpperCase().split(" ")[0],
      lat: parseFloat(s.lat) || 0,
      lon: parseFloat(s.lon) || 0,
    };
  }).filter(s => s.id && s.lat && s.lon);
}

async function scrapeStore(browser, store) {
  const context = await browser.newContext({ locale: "nl-BE", userAgent: HEADERS["User-Agent"] });
  const page = await context.newPage();
  let viewHtml = null;

  page.on("response", async (response) => {
    if (!response.url().includes("renmans.be")) return;
    if (!response.url().includes("/views/ajax")) return;
    if (response.status() !== 200) return;
    try {
      const commands = await response.json();
      if (!Array.isArray(commands)) return;
      const insert = commands.find(c => c.command === "insert" && c.selector?.includes("js-view-dom-id"));
      if (insert?.data) viewHtml = insert.data;
    } catch { }
  });

  try {
    await page.goto(
      `https://www.renmans.be/nl/define-shop/${store.id}/1?redirect=/nl/promotions/1`,
      { waitUntil: "networkidle", timeout: 30000 }
    );

    const htmlToParse = viewHtml || await page.evaluate(() => {
      const v = document.querySelector(".view-content, [class*='js-view-dom-id']");
      return v ? v.innerHTML : null;
    });

    if (!htmlToParse || htmlToParse.trim().length < 100) {
      if (process.env.DEBUG) {
        console.log(`[Renmans ${store.id}] Leeg. URL: ${page.url()}. HTML:`);
        console.log((await page.content()).slice(0, 2000));
      }
      await context.close();
      return [];
    }

    // Parse HTML met regex (geen node-html-parser in deze repo)
    const deals = [];
    // Zoek views-rows of article elementen
    const rowPattern = /<(?:div class="views-row"|article)[^>]*>([\s\S]*?)(?=<(?:div class="views-row"|article)|$)/gi;
    let rowMatch;
    while ((rowMatch = rowPattern.exec(htmlToParse)) !== null) {
      const chunk = rowMatch[1];

      const titleMatch = chunk.match(/class="[^"]*(?:node__title|field--name-title|product-name|title)[^"]*"[^>]*>(?:<[^>]+>)*([^<]{3,})/i)
        || chunk.match(/<h[23][^>]*>(?:<[^>]+>)*([^<]{3,})/i);
      const title = titleMatch?.[1]?.trim().replace(/&amp;/g, "&").replace(/&#039;/g, "'").replace(/&quot;/g, '"');
      if (!title || title.length < 2) continue;

      const priceMatch = chunk.match(/class="[^"]*price[^"]*"[^>]*>(?:<[^>]+>)*([€\d,. ]+)/i)
        || chunk.match(/€\s*(\d+[,.]?\d*)/);
      const price = parsePrice(priceMatch?.[1] || "");

      const dealMatch = chunk.match(/class="[^"]*(?:field--name-body|promotion-text|deal|promo)[^"]*"[^>]*>(?:<[^>]+>)*([^<]{5,})/i);
      const dealText = dealMatch?.[1]?.trim() || (price > 0 ? "Actieprijs" : "Weekprijs");

      const dateMatch = chunk.match(/class="[^"]*(?:date|valid|geldig)[^"]*"[^>]*>(?:<[^>]+>)*([^<]{5,})/i);
      const validUntil = parseEndDate(dateMatch?.[1]);

      const imgMatch = chunk.match(/src="(https?:\/\/[^"]*renmans[^"]*\.(?:jpg|jpeg|png|webp)[^"]*)"/i)
        || chunk.match(/src="(\/[^"]*\.(?:jpg|jpeg|png|webp)[^"]*)"/i);
      const image = imgMatch?.[1]
        ? (imgMatch[1].startsWith("http") ? imgMatch[1] : `https://www.renmans.be${imgMatch[1]}`)
        : null;

      deals.push({
        id: stableId(store.id, title),
        store: "Renmans",
        storeColor: "#C8102E",
        storeLogo: "R",
        storeCity: store.city,
        storeLat: store.lat,
        storeLon: store.lon,
        renmanStoreId: store.id,
        item: title,
        deal: dealText,
        category: inferCategory(title),
        originalPrice: price,
        newPrice: price,
        savings: 0,
        emoji: "🥩",
        validUntil,
        hot: false,
        image,
      });
    }

    await context.close();
    return deals;
  } catch (err) {
    await context.close().catch(() => {});
    throw err;
  }
}

async function saveRenmansToSupabase(deals) {
  if (!SUPABASE_URL || !SUPABASE_KEY) return;
  const res = await fetch(`${SUPABASE_URL}/rest/v1/cache`, {
    method: "POST",
    headers: {
      "apikey": SUPABASE_KEY,
      "Authorization": `Bearer ${SUPABASE_KEY}`,
      "Content-Type": "application/json",
      "Prefer": "resolution=merge-duplicates",
    },
    body: JSON.stringify({ key: "renmans", data: deals, updated_at: new Date().toISOString() }),
  });
  if (res.ok) console.log(`[Renmans] Supabase: ${deals.length} deals opgeslagen`);
  else console.error("[Renmans] Supabase save mislukt:", res.status);
}

async function scrapeAllRenmans(runWithBrowser) {
  const stores = await getStoreList();
  console.log(`[Renmans] ${stores.length} winkels gevonden`);

  const allDeals = [];
  const BATCH_SIZE = 6;

  for (let i = 0; i < stores.length; i += BATCH_SIZE) {
    const batch = stores.slice(i, i + BATCH_SIZE);
    const results = await Promise.allSettled(
      batch.map(s => runWithBrowser(`Renmans ${s.city}`, b => scrapeStore(b, s)))
    );
    for (let j = 0; j < batch.length; j++) {
      const r = results[j];
      if (r.status === "fulfilled") allDeals.push(...r.value);
    }
    console.log(`[Renmans] Batch ${Math.floor(i / BATCH_SIZE) + 1}/${Math.ceil(stores.length / BATCH_SIZE)} klaar`);
  }

  console.log(`[Renmans] Totaal: ${allDeals.length} deals`);
  if (allDeals.length > 0) await saveRenmansToSupabase(allDeals);
  else console.warn("[Renmans] 0 deals — stel DEBUG=true in voor HTML-dump");

  return allDeals;
}

module.exports = { scrapeAllRenmans };
