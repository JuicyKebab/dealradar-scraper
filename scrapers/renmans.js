import { fetch as undiciFetch } from "undici";
import crypto from "crypto";
import { chromium } from "playwright";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

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

function stableId(storeId, name) {
  const hash = crypto.createHash("md5").update(name || "").digest("hex").slice(0, 8);
  return `renmans-${storeId}-${hash}`;
}

function inferCategory(name) {
  if (!name) return "Vlees & Vis";
  const n = name.toLowerCase();
  if (n.includes("kip") || n.includes("poulet")) return "Vlees & Vis";
  if (n.includes("varken") || n.includes("porc")) return "Vlees & Vis";
  if (n.includes("rund") || n.includes("boeuf")) return "Vlees & Vis";
  if (n.includes("lam") || n.includes("agneau")) return "Vlees & Vis";
  if (n.includes("worst") || n.includes("saucisse")) return "Vlees & Vis";
  if (n.includes("ham") || n.includes("jambon")) return "Vlees & Vis";
  if (n.includes("zalm") || n.includes("saumon") || n.includes("vis")) return "Vlees & Vis";
  if (n.includes("kaas") || n.includes("fromage")) return "Zuivel";
  if (n.includes("wijn") || n.includes("vin") || n.includes("bier")) return "Dranken";
  return "Vlees & Vis";
}

function parseDrupalSettings(html) {
  const match = html.match(/data-drupal-selector="drupal-settings-json"[^>]*>([^<]+)<\/script>/);
  if (!match) return null;
  try {
    return JSON.parse(match[1]);
  } catch {
    return null;
  }
}

// Build deals from drupalSettings.view_promo + info_calcul
// Mapping: products are sorted by their `index` field; info_calcul keys are in the same order
function buildDeals(settings, store) {
  const viewPromo = settings.view_promo;
  const infoCalcul = settings.info_calcul;
  if (!viewPromo || !infoCalcul) return [];

  const allProducts = [
    ...(viewPromo.promo_card || []),
    ...(viewPromo.promo_week || []),
  ].sort((a, b) => (a.index || 0) - (b.index || 0));

  const pluKeys = Object.keys(infoCalcul);
  const promoGlobal = settings.promo_global || {};
  const promoEnd = promoGlobal.date_end || null;

  return allProducts.map((product, i) => {
    const name = product.item_name;
    if (!name || name.length < 2) return null;

    // Price from info_calcul — same order as sorted products
    const plu = pluKeys[i];
    const calcData = plu ? infoCalcul[plu] : null;
    const promoPrice = calcData?.infos_promo?.ws_promo_price
      ? parseFloat(calcData.infos_promo.ws_promo_price)
      : 0;
    const weight = calcData?.weigth || null; // grams

    // Build deal description
    let deal = "Weekprijs";
    if (promoPrice > 0 && weight) {
      deal = `${promoPrice.toFixed(2).replace(".", ",")} € / ${weight}g`;
    } else if (promoPrice > 0) {
      deal = `${promoPrice.toFixed(2).replace(".", ",")} €`;
    }

    // Valid until from promo_global or default 7 days
    let validUntil = dutchDate(7);
    if (promoEnd) {
      const d = new Date(promoEnd);
      if (!isNaN(d)) {
        validUntil = `${_DAYS[d.getDay()]} ${d.getDate()} ${_MONTHS[d.getMonth()]}`;
      }
    }

    return {
      id: stableId(store.id, name),
      store: "Renmans",
      storeColor: "#C8102E",
      storeLogo: "R",
      storeCity: store.city,
      storeLat: store.lat,
      storeLon: store.lon,
      renmanStoreId: store.id,
      item: name,
      deal,
      category: inferCategory(name),
      originalPrice: promoPrice,
      newPrice: promoPrice,
      savings: 0,
      emoji: "🥩",
      validUntil,
      hot: false,
      image: null,
    };
  }).filter(Boolean);
}

// Playwright-based: navigate to define-shop in existing browser context (session already established)
async function fetchStorePromosPlaywright(page, store) {
  const defineUrl = `https://www.renmans.be/nl/define-shop/${store.id}/1?redirect=/nl/promotions/1?field_filter_tags[429]=429&search=`;
  await page.goto(defineUrl, { waitUntil: "networkidle", timeout: 20000 });

  // view_promo is loaded via AJAX after networkidle — wait for it
  try {
    await page.waitForFunction(() => !!window.drupalSettings?.view_promo, { timeout: 8000 });
  } catch {
    // Some stores genuinely have no promos
  }

  const settings = await page.evaluate(() => window.drupalSettings ?? null);
  if (!settings?.view_promo) {
    console.log(`[Renmans ${store.id}] No view_promo — store has no active promotions`);
    return [];
  }
  const deals = buildDeals(settings, store);
  console.log(`[Renmans] ${store.city} (${store.id}): ${deals.length} deals`);
  return deals;
}

async function getStoreList() {
  const res = await undiciFetch("https://www.renmans.be/nl/promoties", { headers: HEADERS });
  if (!res.ok) throw new Error(`Renmans store list fetch failed: ${res.status}`);
  const html = await res.text();

  const settings = parseDrupalSettings(html);
  if (!settings) throw new Error("Drupal settings JSON not found in store list page");

  const stores = settings.stores?.stores || settings.stores;
  if (!Array.isArray(stores) || stores.length === 0) throw new Error("No stores in Drupal settings");

  return stores.map(s => {
    const idMatch = s.link?.match(/\/define-shop\/(\d+)\//);
    return {
      id: idMatch?.[1] || null,
      title: s.title || "",
      city: (s.city || s.title || "").toUpperCase().split(" ")[0],
      lat: parseFloat(s.lat) || 0,
      lon: parseFloat(s.lon) || 0,
      address: s.address || "",
      zipcode: s.zipcode || "",
    };
  }).filter(s => s.id && s.lat && s.lon);
}

async function supabaseWrite(deals) {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    throw new Error("Supabase env vars missing");
  }
  const res = await fetch(`${SUPABASE_URL}/rest/v1/cache`, {
    method: "POST",
    headers: {
      "apikey": SUPABASE_SERVICE_KEY,
      "Authorization": `Bearer ${SUPABASE_SERVICE_KEY}`,
      "Content-Type": "application/json",
      "Prefer": "resolution=merge-duplicates",
    },
    body: JSON.stringify({ key: "renmans", data: deals, updated_at: new Date().toISOString() }),
  });
  if (!res.ok) throw new Error(`Supabase write failed: ${res.status} ${await res.text()}`);
}

// Probe: test 1 store via local Playwright (no Brightdata cost) to see if JS store selection works
export async function probeRenmans() {
  const stores = await getStoreList();
  const storeCount = stores.length;
  if (storeCount === 0) return { ok: false, error: "No stores found", storeCount: 0 };

  const probe = stores[0];
  let browser, ctx, page;
  try {
    browser = await chromium.launch({ headless: true, args: ["--no-sandbox", "--disable-setuid-sandbox"] });
    ctx = await browser.newContext({ locale: "nl-BE", userAgent: HEADERS["User-Agent"] });
    page = await ctx.newPage();

    // Establish session first
    await page.goto("https://www.renmans.be/nl/promotions/1", { waitUntil: "networkidle", timeout: 30000 });

    // Navigate to define-shop (session now exists, AJAX will load promo data)
    const defineUrl = `https://www.renmans.be/nl/define-shop/${probe.id}/1?redirect=/nl/promotions/1?field_filter_tags[429]=429&search=`;
    await page.goto(defineUrl, { waitUntil: "networkidle", timeout: 30000 });

    // view_promo is loaded via AJAX after networkidle — wait for it
    try {
      await page.waitForFunction(() => !!window.drupalSettings?.view_promo, { timeout: 10000 });
    } catch {}

    const settings = await page.evaluate(() => window.drupalSettings ?? null);
    const deals = settings?.view_promo ? buildDeals(settings, probe) : [];

    // Diagnostic: list top-level keys and check for promo-related keys at any depth
    const settingsKeys = settings ? Object.keys(settings) : [];
    const promoKeys = settingsKeys.filter(k => /promo|deal|product|view|calcul/i.test(k));
    const pageUrl = page.url();

    return {
      ok: deals.length > 0,
      storeCount,
      probeStore: { id: probe.id, city: probe.city },
      hasViewPromo: !!(settings?.view_promo),
      dealCount: deals.length,
      sampleDeal: deals[0] ?? null,
      diag: { settingsKeys, promoKeys, pageUrl },
    };
  } catch (err) {
    return { ok: false, error: err.message, storeCount };
  } finally {
    await page?.close().catch(() => {});
    await ctx?.close().catch(() => {});
    await browser?.close();
  }
}

export async function scrapeAllRenmans() {
  const stores = await getStoreList();
  console.log(`[Renmans] ${stores.length} stores found`);

  const allDeals = [];
  const errors = {};
  let browser, ctx, page;

  try {
    browser = await chromium.launch({ headless: true, args: ["--no-sandbox", "--disable-setuid-sandbox"] });
    ctx = await browser.newContext({ locale: "nl-BE", userAgent: HEADERS["User-Agent"] });
    page = await ctx.newPage();

    // Establish session by visiting promotions page first
    await page.goto("https://www.renmans.be/nl/promotions/1", { waitUntil: "networkidle", timeout: 30000 });
    // Wait for AJAX promo data on session page
    try {
      await page.waitForFunction(() => !!window.drupalSettings?.view_promo, { timeout: 10000 });
    } catch {}
    console.log("[Renmans] Session established");

    // Navigate to each store sequentially (same session = context preserved)
    for (const store of stores) {
      try {
        const deals = await fetchStorePromosPlaywright(page, store);
        allDeals.push(...deals);
      } catch (err) {
        errors[store.id] = err.message || "unknown";
        console.error(`[Renmans] ${store.city} (${store.id}) ERROR:`, err.message);
      }
    }
  } finally {
    await page?.close().catch(() => {});
    await ctx?.close().catch(() => {});
    await browser?.close();
  }

  const counts = { total: allDeals.length, stores: stores.length, errors: Object.keys(errors).length };
  console.log("[Renmans] Done:", counts);

  if (allDeals.length > 0) {
    await supabaseWrite(allDeals);
    console.log(`[Renmans] Wrote ${allDeals.length} deals to Supabase`);
  } else {
    console.warn("[Renmans] No deals found — all stores may have no active promotions");
  }

  return { counts, errors };
}
