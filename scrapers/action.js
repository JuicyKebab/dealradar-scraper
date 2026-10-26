// Action scraper — weekactie page via Playwright met handmatige stealth scripts
import { chromium } from "playwright";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const _MONTHS = ["januari","februari","maart","april","mei","juni","juli","augustus","september","oktober","november","december"];

// Action weekdeals lopen do → wo; zoek de eerstvolgende woensdag
function actionValidUntil() {
  const d = new Date();
  const daysUntilWed = (3 - d.getDay() + 7) % 7 || 7;
  d.setDate(d.getDate() + daysUntilWed);
  return `wo ${d.getDate()} ${_MONTHS[d.getMonth()]}`;
}

function slugify(str) {
  return str.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function categorize(name) {
  const n = (name || "").toLowerCase();
  // Verzorging eerst — voorkomt dat "zonnebrandmelk" als Zuivel wordt geclassificeerd
  if (/shampoo|deo|tandpast|verzorg|lotion|huid|haar|zeep|parfum|make-up|cosmet|scheer|body|zonnebrand|zonnemelk|sunscreen|spf/.test(n)) return "Verzorging";
  if (/wasmiddel|schoonmaak|reinig|vaat|huishoud|afval|toilet|papier|was |doek|spons/.test(n)) return "Huishouden";
  if (/snack|chips|koek|chocola|snoep|noot|ontbijt|muesli|granola|koffie|thee|drank|frisdrank|bier|wijn|cola|sap/.test(n)) return "Bakkerij & Snacks";
  if (/vlees|vis|kip|zalm|ham|worst|charcuterie/.test(n)) return "Vlees & Vis";
  if (/yoghurt|kaas|zuivel|boter|eieren/.test(n)) return "Zuivel";
  if (/groenten|fruit|aardappel|salade/.test(n)) return "Groenten & Fruit";
  if (/pasta|rijst|soep|saus|conserven|droogwaren/.test(n)) return "Droogwaren";
  return "Overig";
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
    body: JSON.stringify({ key: "action", data: deals, updated_at: new Date().toISOString() }),
  });
  if (!res.ok) throw new Error(`Supabase write failed: ${res.status} ${await res.text()}`);
}

export async function scrapeAction({ diagnose = false } = {}) {
  const sbUser = process.env.BRIGHTDATA_SB_USER;
  const sbPass = process.env.BRIGHTDATA_SB_PASS;
  if (!sbUser || !sbPass) throw new Error("Missing BRIGHTDATA_SB_USER / BRIGHTDATA_SB_PASS");

  const endpointURL = `wss://${sbUser}:${sbPass}@brd.superproxy.io:9222`;
  let browser;
  const deals = [];
  const interceptedProducts = [];

  let ctx, page;
  try {
    browser = await chromium.connectOverCDP(endpointURL);
    ctx = await browser.newContext();
    page = await ctx.newPage();

    // Intercept JSON API responses
    page.on("response", async (res) => {
      const ct = res.headers()["content-type"] || "";
      if (!ct.includes("json")) return;
      try {
        const json = await res.json();
        const items = json?.products || json?.items || json?.data || json?.results || json?.entries;
        if (Array.isArray(items) && items.length > 2) {
          console.log(`[action] API hit: ${res.url().slice(0, 120)} → ${items.length} items`);
          interceptedProducts.push(...items);
        }
      } catch { /* ignore */ }
    });

    // Extraheer producten via data-testid selectors
    function extractProducts() {
      const results = [];
      const cards = document.querySelectorAll('[data-testid="product-card"]');
      for (const card of cards) {
        const link = card.querySelector('[data-testid="product-card-link"]');
        const titleEl = card.querySelector('[data-testid="product-card-title"]');
        const wholeEl = card.querySelector('[data-testid="product-card-price-whole"]');
        const fracEl = card.querySelector('[data-testid="product-card-price-fractional"]');
        const imgEl = card.querySelector('[data-testid="product-card-image"]') || card.querySelector("img");
        const name = titleEl?.textContent?.trim() || "";
        if (!name || name.length < 2) continue;
        const whole = wholeEl?.textContent?.replace(/\D/g, "") || "0";
        const frac = fracEl?.textContent?.replace(/\D/g, "") || "00";
        const price = `${whole}.${frac}`;
        const href = link?.href || "";
        const img = imgEl?.src || imgEl?.getAttribute("data-src") || "";
        results.push({ name, price, image: img, href });
      }
      // Fallback: probeer product-card-link als geen cards gevonden
      if (results.length === 0) {
        const links = document.querySelectorAll('[data-testid="product-card-link"]');
        for (const link of links) {
          const container = link.closest("div") || link;
          const titleEl = container.querySelector('[data-testid="product-card-title"]') || link;
          const name = titleEl?.textContent?.trim()?.split("\n")[0]?.trim() || "";
          if (!name || name.length < 2) continue;
          const priceMatch = container.textContent.match(/(\d+)[,.](\d{2})/);
          const imgEl = container.querySelector("img");
          results.push({
            name,
            price: priceMatch ? `${priceMatch[1]}.${priceMatch[2]}` : "0",
            image: imgEl?.src || imgEl?.getAttribute("data-src") || "",
            href: link.href || "",
          });
        }
      }
      return results;
    }

    // Zoek de volgende paginalink via data-testid
    function findNextPageUrl(currentPage) {
      const nextPageNum = currentPage + 1;
      // GridPaginationLink met juiste pagina
      const paginationLinks = document.querySelectorAll('[data-testid="GridPaginationLink"]');
      for (const link of paginationLinks) {
        if (link.href?.includes(`page=${nextPageNum}`)) return link.href.split("#")[0];
      }
      // Fallback: zoek elke link met ?page=N
      const explicit = document.querySelector(`a[href*="?page=${nextPageNum}"]`);
      if (explicit) return explicit.href.split("#")[0];
      return null;
    }

    const seenHrefs = new Set();
    const rawProducts = [];
    let currentUrl = "https://www.action.com/nl-be/weekactie/";
    let pageNum = 1;

    // Loop door alle pagina's
    while (currentUrl && pageNum <= 10) {
      await page.goto(currentUrl, { waitUntil: "domcontentloaded", timeout: 90_000 });
      // Wacht op product cards via data-testid
      const selectorFound = await page.waitForSelector('[data-testid="product-card"]', { timeout: 30_000 }).catch(() => null);
      if (!selectorFound) console.log(`[action] WAARSCHUWING: geen product-card gevonden op pagina ${pageNum}`);
      await page.waitForTimeout(2000);

      // Diagnose-modus: return HTML structuur voor debugging
      if (diagnose && pageNum === 1) {
        const htmlDiag = await page.evaluate(() => {
          // Find main content area (skip header/nav)
          const _main = document.querySelector("main") || document.querySelector("[role='main']") || document.querySelector(".flex.min-h-screen > div:nth-child(2)") || document.body;
          // All unique data-testid values in the page
          const allTestIds = [...new Set([...document.querySelectorAll("[data-testid]")].map(el => el.getAttribute("data-testid")))];
          // All links with /p/ anywhere
          const productLinks = [...document.querySelectorAll("a[href*='/p/']")].slice(0, 10).map(a => ({
            href: a.href, text: a.textContent.trim().slice(0, 60),
            outerHtml: a.outerHTML.slice(0, 300),
            parentTag: a.parentElement?.tagName,
            parentClass: a.parentElement?.className?.slice?.(0, 80),
          }));
          // All img tags (product images)
          const images = [...document.querySelectorAll("img[src*='action'], img[data-src], img[loading='lazy']")].slice(0, 10).map(img => ({
            src: (img.src || img.dataset.src || "").slice(0, 120),
            alt: img.alt?.slice(0, 60),
            parentClass: img.parentElement?.className?.slice?.(0, 60),
            grandparentTag: img.parentElement?.parentElement?.tagName,
            grandparentClass: img.parentElement?.parentElement?.className?.slice?.(0, 60),
          }));
          // Main content HTML (skip first 5000 chars which is likely header)
          const fullHtml = document.body.innerHTML;
          const mainHtml = fullHtml.slice(5000, 20000);
          // All elements with price-like content
          const priceEls = [...document.querySelectorAll("span, p, div")].filter(el => {
            const t = el.textContent.trim();
            return /^\d{1,3}[,.]\d{2}$/.test(t) || /^\u20AC\s?\d/.test(t);
          }).slice(0, 15).map(el => ({
            tag: el.tagName, class: el.className?.slice?.(0, 60),
            text: el.textContent.trim().slice(0, 30),
            parentClass: el.parentElement?.className?.slice?.(0, 60),
          }));
          return { allTestIds, productLinks, images, priceEls, mainHtml, url: location.href, title: document.title };
        });
        await page?.close().catch(() => {});
        await ctx?.close().catch(() => {});
        await browser?.close();
        return { diagnose: true, ...htmlDiag };
      }

      const batch = await page.evaluate(extractProducts);
      if (batch.length === 0 && pageNum === 1) {
        // Log eerste 3000 tekens HTML voor diagnose
        const html = await page.evaluate(() => document.body?.innerHTML?.slice(0, 3000) || "");
        console.log(`[action] GEEN producten gevonden op pagina 1. HTML snippet:\n${html}`);
      }
      let newThisPage = 0;
      for (const p of batch) {
        const dedupKey = p.href || slugify(p.name);
        if (!dedupKey || seenHrefs.has(dedupKey)) continue;
        seenHrefs.add(dedupKey);
        rawProducts.push(p);
        newThisPage++;
      }

      const nextUrl = await page.evaluate(findNextPageUrl, pageNum);
      console.log(`[action] pagina ${pageNum}: ${newThisPage} nieuwe producten, next=${nextUrl || "none"}`);

      if (nextUrl) {
        currentUrl = nextUrl;
        pageNum++;
      } else {
        break;
      }
    }

    const domProducts = rawProducts;
    console.log(`[action] paginering klaar: ${domProducts.length} producten over ${pageNum} pagina's`);

    const validUntil = actionValidUntil();
    const seen = new Set();

    // Map NL deal IDs to URL slugs for FR matching
    const nlIdToUrlSlug = new Map();

    // Parse DOM products
    for (const p of domProducts) {
      if (!p.name || p.name.length < 2) continue;
      const slug = slugify(p.name);
      const id = `action-${slug}`;
      const urlSlug = p.href?.match(/\/p\/([^/?#]+)/)?.[1];
      if (urlSlug) nlIdToUrlSlug.set(id, urlSlug);
      if (seen.has(id)) continue;
      seen.add(id);

      const priceMatch = p.price.replace(/\s/g, "").match(/(\d+)[,.](\d{2})/);
      const newPrice = priceMatch ? parseFloat(`${priceMatch[1]}.${priceMatch[2]}`) : 0;
      const category = categorize(p.name);

      deals.push({
        id,
        store: "Action",
        storeColor: "#e20613",
        storeLogo: "AC",
        emoji: "🛍️",
        item: p.name,
        deal: "Weekdeal",
        category,
        originalPrice: 0,
        newPrice,
        savings: 0,
        image: p.image || null,
        validUntil,
        hot: false,
      });
    }

    // Also parse intercepted API products (deduped against DOM results)
    for (const p of interceptedProducts) {
      const name = p.name || p.title || p.productName || p.label || "";
      if (!name) continue;
      const slug = slugify(name);
      const id = `action-${p.id || p.sku || p.productId || slug}`;
      if (seen.has(id) || seen.has(`action-${slug}`)) continue;
      seen.add(id);
      seen.add(`action-${slug}`);

      const newPrice = parseFloat(p.price?.current || p.currentPrice || p.price || 0) || 0;
      const originalPrice = parseFloat(p.price?.original || p.originalPrice || p.regularPrice || 0) || 0;
      const savings = originalPrice > newPrice && originalPrice > 0
        ? Math.round((1 - newPrice / originalPrice) * 100)
        : 0;

      deals.push({
        id,
        store: "Action",
        storeColor: "#e20613",
        storeLogo: "AC",
        emoji: "🛍️",
        item: name,
        deal: savings > 0 ? `-${savings}%` : "Weekdeal",
        category: categorize(name),
        originalPrice,
        newPrice,
        savings,
        image: p.image || p.imageUrl || p.thumbnail || null,
        validUntil,
        hot: savings >= 40,
      });
    }

    console.log(`[action] DOM: ${domProducts.length}, API: ${interceptedProducts.length}, total unique: ${deals.length}`);

    // FR namen ophalen via dezelfde browser sessie
    const frNames = new Map(); // key by URL slug
    const frByImage = new Map(); // fallback: image URL -> FR name
    try {
      let frUrl = "https://www.action.com/fr-be/offre-de-la-semaine/";
      let frPageNum = 1;
      while (frUrl && frPageNum <= pageNum) {
        await page.goto(frUrl, { waitUntil: "domcontentloaded", timeout: 90_000 });
        await page.waitForSelector('[data-testid="product-card"]', { timeout: 30_000 }).catch(() => null);
        await page.waitForTimeout(2000);
        const batch = await page.evaluate(extractProducts);
        for (const p of batch) {
          if (p.name && p.href) {
            const urlSlug = p.href.match(/\/p\/([^/?#]+)/)?.[1] || slugify(p.name);
            frNames.set(`action-${urlSlug}`, p.name);
          }
          if (p.name && p.image) frByImage.set(p.image, p.name);
        }
        const nextUrl = await page.evaluate(findNextPageUrl, frPageNum);
        frUrl = nextUrl;
        frPageNum++;
      }
      console.log(`[action] FR namen: ${frNames.size} by slug, ${frByImage.size} by image`);
    } catch (err) {
      console.log(`[action] FR fetch fout: ${err.message}`);
    }
    for (const deal of deals) {
      const urlSlug = nlIdToUrlSlug.get(deal.id);
      const fr = (urlSlug && frNames.get(`action-${urlSlug}`)) || frNames.get(deal.id) || (deal.image && frByImage.get(deal.image));
      if (fr) deal.item_fr = fr;
    }
  } finally {
    await page?.close().catch(() => {});
    await ctx?.close().catch(() => {});
    await browser?.close();
  }

  if (deals.length > 0) {
    await supabaseWrite(deals);
  }

  return { total: deals.length };
}
