// Drinxit scraper — Playwright (client-side rendered nopCommerce)
// Promo's verschillen per subdomain → alle scrapen en dedupen op productId.
import { chromium } from "playwright";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const PROMO_URLS = [
  "https://brugge.drinxit.be/promotions",
  "https://roeselare.drinxit.be/promotions",
  "https://likovin.drinxit.be/promotions",
];

const _DAYS   = ["zo","ma","di","wo","do","vr","za"];
const _MONTHS = ["januari","februari","maart","april","mei","juni","juli","augustus","september","oktober","november","december"];

function dutchDate(daysFromNow = 7) {
  const d = new Date();
  d.setDate(d.getDate() + daysFromNow);
  return `${_DAYS[d.getDay()]} ${d.getDate()} ${_MONTHS[d.getMonth()]}`;
}

// Parse ribbon tekst naar { deal, savings, bundleBuy, bundleFree, isBundleDeal }
function parseRibbon(ribbon) {
  const r = ribbon.trim();
  const ru = r.toUpperCase();

  // "N + M GRATIS" of "N+M GRATIS"
  const bundleMatch = ru.match(/(\d+)\s*\+\s*(\d+)\s+GRATIS/);
  if (bundleMatch) {
    const buy = parseInt(bundleMatch[1]);
    const free = parseInt(bundleMatch[2]);
    return {
      deal: `${buy}+${free} gratis`,
      savings: Math.round(free / (buy + free) * 100),
      bundleBuy: buy,
      bundleFree: free,
      isBundleDeal: true,
    };
  }

  // "NDE BAK -X%" of "NE BAK -X%"
  const bakMatch = ru.match(/(\d+)(?:DE|E)\s+BAK\s*[-\u2013]?\s*(\d+)%/);
  if (bakMatch) {
    const nth = parseInt(bakMatch[1]);
    const pct = parseInt(bakMatch[2]);
    return {
      deal: r,
      savings: Math.round(pct / nth),
      isBundleDeal: true,
    };
  }

  // "- X%" of "-X%"
  const pctMatch = ru.match(/[-\u2013]\s*(\d+)%/);
  if (pctMatch) {
    return { deal: r, savings: parseInt(pctMatch[1]), isBundleDeal: false };
  }

  return { deal: r, savings: 0, isBundleDeal: false };
}

async function extractItems(page) {
  return page.evaluate(() => {
    const items = [...document.querySelectorAll(".item-box")];
    return items.map(item => {
      // Ribbon = de promo-badge (bv. "5 + 1 gratis"), NIET de producttitel.
      const ribbonEl = item.querySelector(".jama-overlay-ribbon, .ribbon-label, [class*='ribbon']");
      const ribbonText = (ribbonEl?.textContent || "").trim();

      const name = (
        item.querySelector(".product-title a")?.textContent ||
        item.querySelector(".product-title")?.textContent ||
        item.querySelector("h2 a")?.textContent ||
        item.querySelector("h2")?.textContent ||
        ""
      ).trim();

      const productId = item.querySelector("[data-productid]")?.getAttribute("data-productid") ||
        (item.querySelector(".product-title a, h2 a, .picture a")?.getAttribute("href") || "").split("/").filter(Boolean).pop();

      const parsePrice = (str) => {
        if (!str) return 0;
        return parseFloat(str.replace(/[^\d.,]/g, "").replace(",", ".")) || 0;
      };

      const newPrice = parsePrice(
        item.querySelector(".actual-price")?.textContent ||
        item.querySelector(".jama-actual-price")?.textContent ||
        item.querySelector(".product-price")?.textContent ||
        ""
      );

      const originalPrice = parsePrice(
        item.querySelector(".old-price")?.textContent ||
        item.querySelector(".non-discounted-price")?.textContent ||
        ""
      );

      const img = (
        item.querySelector("[data-lazyloadsrc]")?.getAttribute("data-lazyloadsrc") ||
        item.querySelector("img[data-src]")?.getAttribute("data-src") ||
        item.querySelector("img")?.getAttribute("src") ||
        ""
      ).trim();

      return { ribbonText, name, productId, newPrice, originalPrice, img };
    });
  });
}

async function fetchPromos() {
  let browser;
  try {
    browser = await chromium.launch({ headless: true, args: ["--no-sandbox", "--disable-setuid-sandbox"] });
    const ctx = await browser.newContext({
      locale: "nl-BE",
      userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
    });
    const page = await ctx.newPage();

    const allItems = [];
    let anyLoaded = false;
    let explicitEmpty = false;

    // Promo's verschillen per subdomain → alle bezoeken en samenvoegen.
    for (const url of PROMO_URLS) {
      try {
        await page.goto(url, { waitUntil: "networkidle", timeout: 30_000 });
        await page.waitForSelector(".item-box, .no-result", { timeout: 10_000 }).catch(() => {});
        anyLoaded = true;
        const items = await extractItems(page);
        if (items.length > 0) {
          allItems.push(...items);
        } else if (/geen promoties/i.test(await page.evaluate(() => document.body.textContent || ""))) {
          explicitEmpty = true;
        }
        console.log(`[Drinxit] ${url}: ${items.length} items`);
      } catch (e) {
        console.warn(`[Drinxit] ${url} mislukt: ${e.message}`);
      }
    }
    if (!anyLoaded) throw new Error("Alle Drinxit promo-URLs gefaald");

    await page.close();
    await ctx.close();
    // emptyState alleen als nergens items én minstens één subdomain expliciet "geen promoties" meldt.
    return { items: allItems, emptyState: allItems.length === 0 && explicitEmpty };
  } finally {
    await browser?.close();
  }
}

function buildDeals(rawItems) {
  const deals = [];
  const seen = new Set();
  for (const item of rawItems) {
    if (!item.ribbonText || !item.name || !item.productId) continue;
    if (seen.has(item.productId)) continue;
    seen.add(item.productId);

    const { deal, savings, bundleBuy, bundleFree, isBundleDeal } = parseRibbon(item.ribbonText);

    let origPrice = item.originalPrice;
    if (!isBundleDeal && origPrice === 0 && savings > 0 && item.newPrice > 0) {
      origPrice = parseFloat((item.newPrice / (1 - savings / 100)).toFixed(2));
    }

    deals.push({
      id: `drinxit-${item.productId}`,
      store: "Drankenhandels",
      storeColor: "#1a3a6b",
      storeLogo: "DH",
      emoji: "\uD83C\uDF7A",
      item: item.name,
      deal,
      category: "Dranken",
      originalPrice: isBundleDeal ? 0 : origPrice,
      newPrice: item.newPrice,
      savings,
      bundleBuy: bundleBuy || null,
      bundleFree: bundleFree || null,
      image: item.img,
      hot: savings >= 30,
      validUntil: dutchDate(7),
    });
  }
  return deals;
}

async function supabaseWrite(deals) {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    throw new Error("[Drinxit] Supabase env vars ontbreken");
  }
  const res = await fetch(`${SUPABASE_URL}/rest/v1/cache`, {
    method: "POST",
    headers: {
      apikey: SUPABASE_SERVICE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
      "Content-Type": "application/json",
      Prefer: "resolution=merge-duplicates",
    },
    body: JSON.stringify({ key: "drinxit", data: deals, updated_at: new Date().toISOString() }),
  });
  if (!res.ok) throw new Error(`Supabase write mislukt: ${res.status} ${await res.text()}`);
}

export async function scrapeAllDrinxit() {
  const { items: rawItems, emptyState } = await fetchPromos();
  const deals = buildDeals(rawItems);
  console.log(`[Drinxit] ${deals.length} deals gevonden (uit ${rawItems.length} items over ${PROMO_URLS.length} subdomains)`);
  if (deals.length === 0) {
    if (emptyState) {
      console.warn("[Drinxit] Alle subdomains melden 'geen promoties' — geen fout, cache behouden");
      return { count: 0, emptyState: true };
    }
    console.warn("[Drinxit] 0 deals gevonden — Supabase niet overschreven");
    return { count: 0 };
  }
  await supabaseWrite(deals);
  return { count: deals.length };
}
