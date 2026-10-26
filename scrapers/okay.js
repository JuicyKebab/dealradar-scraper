// OKay scraper — via Brightdata Scraping Browser (auth vereist via cookies)
// Structuur identiek aan Colruyt ECG API (zelfde Colruyt Group backend)
import { chromium } from "playwright";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const _MONTHS = ["januari","februari","maart","april","mei","juni","juli","augustus","september","oktober","november","december"];
const _DAYS = ["zo","ma","di","wo","do","vr","za"];

function apiDateToDutch(dateStr) {
  if (!dateStr) return "";
  // Formaat: "21-04-2026"
  const parts = dateStr.split("-");
  if (parts.length === 3) {
    const [d, m, y] = parts.map(Number);
    const date = new Date(y, m - 1, d);
    if (!isNaN(date)) return `${_DAYS[date.getDay()]} ${d} ${_MONTHS[m - 1]}`;
  }
  // ISO: "2026-04-21"
  const d2 = new Date(dateStr.slice(0, 10));
  if (!isNaN(d2)) return `${_DAYS[d2.getDay()]} ${d2.getDate()} ${_MONTHS[d2.getMonth()]}`;
  return "";
}

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
  const lower = (cat || "").toLowerCase();
  return CATEGORY_EMOJI[lower] || "🛒";
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
    body: JSON.stringify({ key: "okay", data: deals, updated_at: new Date().toISOString() }),
  });
  if (!res.ok) throw new Error(`Supabase write failed: ${res.status} ${await res.text()}`);
}

// --- Auth token caching (voorkomt SB sessie als token nog geldig is) ---
const TOKEN_CACHE_KEY = "okay_auth";
const TOKEN_MAX_AGE_MS = 48 * 60 * 60 * 1000; // 48u max

async function readCachedToken() {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) return null;
  try {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/cache?key=eq.${TOKEN_CACHE_KEY}&select=data,updated_at`,
      { headers: { apikey: SUPABASE_SERVICE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_KEY}` }, signal: AbortSignal.timeout(5000) }
    );
    if (!res.ok) return null;
    const rows = await res.json();
    const row = rows[0];
    if (!row?.data?.headers) return null;
    // Check leeftijd
    const age = Date.now() - new Date(row.updated_at).getTime();
    if (age > TOKEN_MAX_AGE_MS) { console.log("[okay] cached token te oud, skip"); return null; }
    console.log(`[okay] cached token gevonden (${Math.round(age / 3600000)}u oud)`);
    return row.data;
  } catch { return null; }
}

async function writeCachedToken(headers, placeId) {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) return;
  try {
    await fetch(`${SUPABASE_URL}/rest/v1/cache`, {
      method: "POST",
      headers: {
        apikey: SUPABASE_SERVICE_KEY,
        Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
        "Content-Type": "application/json",
        Prefer: "resolution=merge-duplicates",
      },
      body: JSON.stringify({ key: TOKEN_CACHE_KEY, data: { headers, placeId }, updated_at: new Date().toISOString() }),
      signal: AbortSignal.timeout(5000),
    });
    console.log("[okay] auth token gecached");
  } catch (err) { console.log("[okay] token cache write failed:", err.message); }
}

// Probeer deals op te halen met bestaande auth headers (zonder SB)
async function tryWithCachedToken(cachedHeaders, placeId) {
  const PAGE_SIZE = 24;
  const apiUrl = `https://apip.okay.be/gateway/emec.okay.protected.bffsvc.v1/cg/nl/api/product-search-prs?placeId=${placeId}&page=1&size=${PAGE_SIZE}&sort=relevance+asc&isAvailable=true&discounts=reducedPrice&discounts=redPrice`;
  const res = await fetch(apiUrl, { headers: cachedHeaders, signal: AbortSignal.timeout(10000) });
  if (!res.ok) {
    console.log(`[okay] cached token test: ${res.status}`);
    return null; // token verlopen
  }
  const json = await res.json();
  const products = json.products || [];
  const totalFound = json.productsFound || 0;
  if (products.length === 0) { console.log("[okay] cached token: 0 producten, token mogelijk verlopen"); return null; }
  console.log(`[okay] cached token werkt! page 1: ${products.length}, total: ${totalFound}`);
  return { products, totalFound };
}

// Pagineer alle producten met gegeven auth headers (NL + FR)
async function fetchAllProducts(authHeaders, placeId) {
  const PAGE_SIZE = 24;
  const allProducts = [];
  let totalFound = 0;
  let lastPage = 1;
  let paginationStopReason = null;

  // Pagina 1
  const firstUrl = `https://apip.okay.be/gateway/emec.okay.protected.bffsvc.v1/cg/nl/api/product-search-prs?placeId=${placeId}&page=1&size=${PAGE_SIZE}&sort=relevance+asc&isAvailable=true&discounts=reducedPrice&discounts=redPrice`;
  const firstRes = await fetch(firstUrl, { headers: authHeaders, signal: AbortSignal.timeout(15000) });
  if (!firstRes.ok) return { products: [], totalFound: 0, lastPage: 0, paginationStopReason: `page-1-status-${firstRes.status}` };
  const firstJson = await firstRes.json();
  allProducts.push(...(firstJson.products || []));
  totalFound = firstJson.productsFound || 0;
  console.log(`[okay] page 1: ${allProducts.length} producten, total: ${totalFound}`);

  // Resterende pagina's
  let pageNum = 2;
  while (pageNum <= 20) {
    const apiUrl = `https://apip.okay.be/gateway/emec.okay.protected.bffsvc.v1/cg/nl/api/product-search-prs?placeId=${placeId}&page=${pageNum}&size=${PAGE_SIZE}&sort=relevance+asc&isAvailable=true&discounts=reducedPrice&discounts=redPrice`;
    try {
      const res = await fetch(apiUrl, { headers: authHeaders, signal: AbortSignal.timeout(15000) });
      if (!res.ok) { paginationStopReason = `page-${pageNum}-status-${res.status}`; break; }
      const json = await res.json();
      const products = json.products || [];
      allProducts.push(...products);
      lastPage = pageNum;
      if (products.length < PAGE_SIZE) { paginationStopReason = `page-${pageNum}-incomplete-${products.length}`; break; }
      pageNum++;
    } catch (err) {
      paginationStopReason = `page-${pageNum}-error-${err.message}`;
      break;
    }
  }
  if (!paginationStopReason) paginationStopReason = "completed";

  // FR namen
  const frNames = new Map();
  try {
    let frPage = 1;
    while (frPage <= 20) {
      const frUrl = `https://apip.okay.be/gateway/emec.okay.protected.bffsvc.v1/cg/fr/api/product-search-prs?placeId=${placeId}&page=${frPage}&size=${PAGE_SIZE}&sort=relevance+asc&isAvailable=true&discounts=reducedPrice&discounts=redPrice`;
      const frRes = await fetch(frUrl, { headers: authHeaders, signal: AbortSignal.timeout(15000) });
      if (!frRes.ok) break;
      const frJson = await frRes.json();
      const frProducts = frJson.products || [];
      for (const p of frProducts) {
        const key = p.commercialArticleNumber || p.technicalArticleNumber || p.retailProductNumber;
        if (key && p.name) frNames.set(key, p.name);
      }
      if (frProducts.length < PAGE_SIZE) break;
      frPage++;
    }
    console.log(`[okay] FR namen: ${frNames.size}`);
  } catch (err) { console.log(`[okay] FR fetch fout: ${err.message}`); }

  return { products: allProducts, totalFound, lastPage, paginationStopReason, frNames };
}

// Haal verse auth headers via Brightdata SB
async function getAuthViaBrightdata() {
  const sbUser = process.env.BRIGHTDATA_SB_USER;
  const sbPass = process.env.BRIGHTDATA_SB_PASS;
  if (!sbUser || !sbPass) throw new Error("Missing BRIGHTDATA_SB_USER / BRIGHTDATA_SB_PASS");

  const endpointURL = `wss://${sbUser}:${sbPass}@brd.superproxy.io:9222`;
  let browser, ctx, page;
  let authHeaders = null;
  let placeId = 843;

  try {
    browser = await chromium.connectOverCDP(endpointURL);
    ctx = await browser.newContext();
    page = await ctx.newPage();

    const matchesAuthReq = (u) =>
      u.includes("apip.okay.be") && u.includes("product-search-prs") && u.includes("discounts=");

    page.on("request", (req) => {
      const url = req.url();
      if (matchesAuthReq(url)) {
        authHeaders = req.headers();
        const m = url.match(/placeId=(\d+)/);
        if (m) placeId = parseInt(m[1]);
        console.log(`[okay] SB: auth headers gevangen, placeId=${placeId}`);
      }
    });

    // Wacht expliciet tot de product-search-prs XHR vuurt — via de Scraping Browser
    // kan dit >8s duren (was hardcoded 8s -> "geen auth headers onderschept").
    const authReqPromise = page
      .waitForRequest((req) => matchesAuthReq(req.url()), { timeout: 60_000 })
      .catch(() => null);

    await page.goto("https://www.okay.be/nl/promos/promoties", {
      waitUntil: "domcontentloaded",
      timeout: 90_000,
    });

    const authReq = await authReqPromise;
    if (authReq && !authHeaders) {
      authHeaders = authReq.headers();
      const m = authReq.url().match(/placeId=(\d+)/);
      if (m) placeId = parseInt(m[1]);
      console.log(`[okay] SB: auth headers via waitForRequest, placeId=${placeId}`);
    }
    await page.waitForTimeout(1500); // buffer zodat de listener zeker gevuurd is
    console.log(`[okay] SB: auth=${!!authHeaders}, url=${page.url()}`);
  } finally {
    await page?.close().catch(() => {});
    await ctx?.close().catch(() => {});
    await browser?.close();
  }

  if (!authHeaders) throw new Error("SB: geen auth headers onderschept");
  return { authHeaders, placeId };
}

export async function scrapeOkay() {
  const deals = [];
  let totalFound = 0;
  let lastPage = 1;
  let paginationStopReason = null;
  let usedCachedToken = false;
  let authHeaders = null;
  let placeId = 843;
  let frNames = new Map();

  // Stap 1: probeer cached token
  const cached = await readCachedToken();
  if (cached) {
    try {
      const test = await tryWithCachedToken(cached.headers, cached.placeId);
      if (test) {
        // Token werkt, volledige paginering zonder SB
        usedCachedToken = true;
        authHeaders = cached.headers;
        placeId = cached.placeId;
        console.log("[okay] cached token geldig, SB overgeslagen");
      }
    } catch (err) {
      console.log(`[okay] cached token test fout: ${err.message}`);
    }
  }

  // Stap 2: als cached token niet werkt, SB gebruiken
  if (!authHeaders) {
    console.log("[okay] nieuwe auth via Brightdata SB...");
    const sbResult = await getAuthViaBrightdata();
    authHeaders = sbResult.authHeaders;
    placeId = sbResult.placeId;
    // Cache nieuwe token voor volgende keer
    await writeCachedToken(authHeaders, placeId);
  }

  // Stap 3: pagineer alle producten
  const result = await fetchAllProducts(authHeaders, placeId);
  totalFound = result.totalFound;
  lastPage = result.lastPage;
  paginationStopReason = result.paginationStopReason;
  frNames = result.frNames || new Map();

  console.log(`[okay] ${result.products.length} producten opgehaald (cached token: ${usedCachedToken})`);

  // Als paginering faalde met cached token, retry met verse SB token
  if (usedCachedToken && paginationStopReason && paginationStopReason !== "completed" && result.products.length < 50) {
    console.log("[okay] cached token gaf te weinig resultaten, fallback naar SB...");
    const sbResult = await getAuthViaBrightdata();
    authHeaders = sbResult.authHeaders;
    placeId = sbResult.placeId;
    await writeCachedToken(authHeaders, placeId);
    const retry = await fetchAllProducts(authHeaders, placeId);
    totalFound = retry.totalFound;
    lastPage = retry.lastPage;
    paginationStopReason = retry.paginationStopReason;
    frNames = retry.frNames || new Map();
    result.products = retry.products;
    usedCachedToken = false;
  }

  // Zet om naar deals
  const seen = new Set();
  for (const p of result.products) {
    const id = p.commercialArticleNumber || p.technicalArticleNumber || p.retailProductNumber;
    if (!id || seen.has(id)) continue;
    seen.add(id);

    const pr = p.price || {};
    const basicPrice = pr.basicPrice || 0;
    const qtyPrice = pr.quantityPrice;
    const qtyQty = qtyPrice ? parseFloat(pr.quantityPriceQuantity || 1) : 1;
    const isQtyDeal = qtyPrice && qtyQty > 1 && qtyPrice < basicPrice;
    const savings = isQtyDeal ? Math.round((1 - qtyPrice / basicPrice) * 100) : 0;
    const newPrice = isQtyDeal ? parseFloat(qtyPrice.toFixed(2)) : basicPrice;

    let dealText;
    if (isQtyDeal) dealText = `${Math.round(qtyQty)} voor €${(qtyPrice * qtyQty).toFixed(2)}`;
    else if (pr.isRedPrice) dealText = "Rode prijs";
    else dealText = "Actieprijs";

    const promo = (p.promotion || [])[0] || {};
    const validUntil = promo.publicationEndDate ? apiDateToDutch(promo.publicationEndDate) : dutchDate(7);
    let cat = normalizeCategory(p.topCategoryName);
    const itemLower = (p.name || "").toLowerCase();
    if (cat === "Dranken" && /\b(pleister|bandage|compress|condoom|glijmiddel|massage|tabletten|capsules|spray|ontsmett|vitaminen?|magnesium|calcium|sensitive \d|vingerpleister|vingerbandage|vital \d|energy tabletten|energy bruistabletten|afslank shake)\b/i.test(itemLower)) cat = "Verzorging";

    const deal = {
      id: `okay-${id}`,
      store: "OKay",
      storeColor: "#00a551",
      storeLogo: "OK",
      emoji: categoryToEmoji(cat),
      item: p.name || "Onbekend",
      deal: dealText,
      category: cat,
      originalPrice: basicPrice,
      newPrice,
      savings,
      validUntil,
      hot: promo.topPromo === true || savings >= 40,
      image: (Array.isArray(p.thumbNail) && p.thumbNail.length ? p.thumbNail[0] : p.thumbNail) || (Array.isArray(p.fullImage) && p.fullImage.length ? p.fullImage[0] : p.fullImage) || null,
    };
    const frName = frNames.get(id);
    if (frName) deal.item_fr = frName;
    deals.push(deal);
  }

  console.log(`[okay] ${deals.length} deals (totalFound: ${totalFound}, lastPage: ${lastPage}, stopReason: ${paginationStopReason}, cachedToken: ${usedCachedToken})`);

  const diag = { totalFound, lastPage, paginationStopReason, usedCachedToken };

  // Safeguard
  if (paginationStopReason && paginationStopReason !== "completed" && totalFound > 100 && deals.length < totalFound * 0.3) {
    console.warn(`[okay] Paginering gefaald (${paginationStopReason}): ${deals.length}/${totalFound} deals. Cache niet overschreven.`);
    return { total: deals.length, paginationFailed: true, ...diag };
  }

  if (deals.length > 0) {
    await supabaseWrite(deals);
  }

  return { total: deals.length, ...diag };
}
