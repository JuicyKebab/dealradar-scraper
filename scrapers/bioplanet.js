// Bio-Planet scraper — DOM parsing via Brightdata Scraping Browser
// Producten staan server-side in HTML als data-attributen op .card.card--article
import { chromium } from "playwright";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const _MONTHS = ["januari","februari","maart","april","mei","juni","juli","augustus","september","oktober","november","december"];
const _DAYS = ["zo","ma","di","wo","do","vr","za"];

function dutchDate(daysFromNow = 7) {
  const d = new Date();
  d.setDate(d.getDate() + daysFromNow);
  return `${_DAYS[d.getDay()]} ${d.getDate()} ${_MONTHS[d.getMonth()]}`;
}

function normalizeCategory(raw) {
  if (!raw) return "Overig";
  const s = raw.toLowerCase();
  if (/brood|bakkerij|bakery|ontbijt|gebak|patiss|koek|biscuit|chocolade|snoep|snack|chips|cake|muesli|granola|cereal/.test(s)) return "Bakkerij & Snacks";
  if (/wijn|wine|bier|beer|drank|beverage|frisdrank|water|sap|juice|koffie|coffee|thee|tea|alcohol|spirits|limonade/.test(s)) return "Dranken";
  if (/zuivel|dairy|kaas|cheese|yoghurt|melk|milk|boter|butter|eieren|eggs|room |cream|kwark|margarine/.test(s)) return "Zuivel";
  if (/vlees|meat|vis|fish|charcuterie|bereidingen|veggie|worst|gevogelte|poultry|kip|chicken|varken|rund|beef|zeevruchten|seafood|zalm|ham/.test(s)) return "Vlees & Vis";
  if (/diepvries|frozen|ijsroom|ijscrème|ice cream/.test(s)) return "Diepvries";
  if (/groenten|groente|vegetable|fruit|aardappel|potato|salade|agf/.test(s)) return "Groenten & Fruit";
  if (/pasta|rijst|rice|droog|kruideniers|saus|sauce|conserven|canned|maaltijd|meal|soep|soup|olie|oil|azijn|kruid|spice|bloem|suiker|jam|noten|nuts/.test(s)) return "Droogwaren";
  if (/hygiëne|hygiene|verzorging|care|beauty|cosmet|parfum|lichaam|body|huid|skin|gezondheid|health|haar|hair|mond|dental|scheer|baby/.test(s)) return "Verzorging";
  if (/huishoud|household|schoonmaak|cleaning|reinig|wasmiddel|detergent|papier|paper|keuken|kitchen|afwas|folie|huisdier|hond|kat/.test(s)) return "Huishouden";
  return "Overig";
}

const CATEGORY_EMOJI = {
  "bakkerij & snacks": "🍞", "dranken": "🥤", "zuivel": "🥛", "vlees & vis": "🥩",
  "droogwaren": "🍝", "diepvries": "🧊", "groenten & fruit": "🥦", "verzorging": "🧴",
  "huishouden": "🧹", "overig": "📦",
};
function categoryToEmoji(cat) {
  return CATEGORY_EMOJI[(cat || "").toLowerCase()] || "🛒";
}

async function supabaseWrite(deals) {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) throw new Error("Missing Supabase env vars");
  const res = await fetch(`${SUPABASE_URL}/rest/v1/cache`, {
    method: "POST",
    headers: {
      apikey: SUPABASE_SERVICE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
      "Content-Type": "application/json",
      Prefer: "resolution=merge-duplicates",
    },
    body: JSON.stringify({ key: "bioplanet", data: deals, updated_at: new Date().toISOString() }),
  });
  if (!res.ok) throw new Error(`Supabase write failed: ${res.status} ${await res.text()}`);
}

async function scrapeOnce(endpointURL) {
  let browser, ctx, page;
  const deals = [];
  const diag = {};

  try {
    browser = await chromium.connectOverCDP(endpointURL);
    ctx = await browser.newContext();
    page = await ctx.newPage();

    await page.goto("https://www.bioplanet.be/nl/promos/alle-promos", {
      waitUntil: "domcontentloaded",
      timeout: 90_000,
    });
    await page.waitForTimeout(8000);

    const products = await page.evaluate(() => {
      return [...document.querySelectorAll("a.card.card--article")]
        .map(el => ({
          id: el.getAttribute("retailproductnumber") || el.getAttribute("data-tms-product-id"),
          name: el.getAttribute("longname") || el.getAttribute("data-tms-product-name"),
          dealText: el.getAttribute("data-tms-product-discounts-name"),
          price: parseFloat(el.getAttribute("data-tms-product-price") || "0"),
          category: el.getAttribute("topcategoryname") || "",
          image: el.getAttribute("squareimage") || null,
        }));
    });

    if (products.length === 0) {
      diag.title = await page.title();
      diag.url = page.url();
      diag.cardCount = await page.evaluate(() => document.querySelectorAll("[class*='card']").length);
      console.log(`[bioplanet] 0 producten - diag:`, JSON.stringify(diag));
    } else {
      console.log(`[bioplanet] ${products.length} producten gevonden`);
    }

    const seen = new Set();
    for (const p of products) {
      if (!p.id || seen.has(p.id)) continue;
      seen.add(p.id);
      if (!p.name || !p.price) continue;

      const pctMatch = (p.dealText || "").match(/(\d+)\s*%/);
      const savings = Math.min(99, pctMatch ? parseInt(pctMatch[1]) : 0);
      const originalPrice = savings > 0 ? parseFloat((p.price / (1 - savings / 100)).toFixed(2)) : p.price;
      const newPrice = p.price;

      const cat = normalizeCategory(p.category);
      deals.push({
        id: `bioplanet-${p.id}`,
        store: "Bio-Planet",
        storeColor: "#4caf50",
        storeLogo: "BP",
        emoji: categoryToEmoji(cat),
        item: p.name,
        deal: p.dealText || "Promo",
        category: cat,
        originalPrice,
        newPrice,
        savings,
        validUntil: dutchDate(7),
        hot: savings >= 25,
        image: (Array.isArray(p.image) ? p.image[0] : p.image) || null,
      });
    }

    console.log(`[bioplanet] ${deals.length} deals`);
  } finally {
    await page?.close().catch(() => {});
    await ctx?.close().catch(() => {});
    await browser?.close();
  }

  return { deals, diag };
}

export async function scrapeBioplanet() {
  const sbUser = process.env.BRIGHTDATA_SB_USER;
  const sbPass = process.env.BRIGHTDATA_SB_PASS;
  if (!sbUser || !sbPass) throw new Error("Missing BRIGHTDATA_SB_USER / BRIGHTDATA_SB_PASS");

  const endpointURL = `wss://${sbUser}:${sbPass}@brd.superproxy.io:9222`;

  let result = await scrapeOnce(endpointURL);

  // Retry eenmaal bij 0 deals (Brightdata hiccup/captcha)
  if (result.deals.length === 0) {
    console.log(`[bioplanet] 0 deals op eerste poging, retry na 5s...`);
    await new Promise(r => setTimeout(r, 5000));
    result = await scrapeOnce(endpointURL);
    if (result.deals.length === 0) {
      console.log(`[bioplanet] retry ook 0 deals - diag:`, JSON.stringify(result.diag));
    }
  }

  if (result.deals.length > 0) {
    await supabaseWrite(result.deals);
  }

  return { total: result.deals.length, retried: result.deals.length === 0 ? true : undefined, diag: result.deals.length === 0 ? result.diag : undefined };
}
