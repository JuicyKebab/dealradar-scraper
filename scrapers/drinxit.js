// Drinxit scraper — Playwright (client-side rendered nopCommerce)
// Promo's zijn identiek op alle subdomains; één fetch volstaat.
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

async function fetchPromos() {
  let browser;
  try {
    browser = await chromium.launch({ headless: true, args: ["--no-sandbox", "--disable-setuid-sandbox"] });
    const ctx = await browser.newContext({
      locale: "nl-BE",
      userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
    });
    const page = await ctx.newPage();

    let loaded = false;
    for (const url of PROMO_URLS) {
      try {
        await page.goto(url, { waitUntil: "networkidle", timeout: 30_000 });
        // Wacht tot product-namen gerenderd zijn (client-side)
        await page.waitForSelector(".product-title", { timeout: 10_000 }).catch(() => {});
        loaded = true;
        break;
      } catch (e) {
        console.warn(`[Drinxit] ${url} mislukt: ${e.message}`);
      }
    }
    if (!loaded) throw new Error("Alle Drinxit promo-URLs gefaald");

    // Diagnostiek: dump DOM structuur als er weinig items zijn
    const diag = await page.evaluate(() => {
      const items = [...document.querySelectorAll(".item-box")];
      const sample = items.slice(0, 2).map(el => el.outerHTML.slice(0, 1000));
      // Expliciete lege staat: site toont "Er zijn momenteel geen promoties"
      const noResultEl = document.querySelector(".no-result, .page-body .no-result");
      const emptyState = items.length === 0 && (
        (noResultEl?.textContent || "").toLowerCase().includes("geen promoties") ||
        /geen promoties/i.test(document.querySelector(".page-body")?.textContent || "")
      );
      return {
        title: document.title,
        url: location.href,
        itemBoxCount: items.length,
        productTitleCount: document.querySelectorAll(".product-title").length,
        productNameCount: document.querySelectorAll(".product-name").length,
        ribbonCount: document.querySelectorAll("[class*='ribbon']").length,
        emptyState,
        sampleHtml: sample,
      };
    });
    console.log(`[Drinxit] diag:`, JSON.stringify(diag).slice(0, 2000));

    const deals = await page.evaluate(() => {
      const items = [...document.querySelectorAll(".item-box")];
      return items.map(item => {
        const ribbonEl = item.querySelector(".product-title, .jama-overlay-ribbon, .ribbon-label, [class*='ribbon']");
        const ribbonText = (ribbonEl?.textContent || "").trim();

        const name = (
          item.querySelector(".product-name a")?.textContent ||
          item.querySelector(".product-name")?.textContent ||
          item.querySelector("h2 a")?.textContent ||
          item.querySelector("h2")?.textContent ||
          ""
        ).trim();

        const productId = item.getAttribute("data-productid") ||
          item.querySelector("[data-productid]")?.getAttribute("data-productid") ||
          (item.querySelector("h2 a, .product-name a, .picture a")?.getAttribute("href") || "").split("/").filter(Boolean).pop();

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

    console.log(`[Drinxit] ${deals.length} items van pagina, ${deals.filter(d => d.ribbonText).length} met ribbon`);

    await page.close();
    await ctx.close();
    return { items: deals, diag };
  } finally {
    await browser?.close();
  }
}

function buildDeals(rawItems) {
  const deals = [];
  for (const item of rawItems) {
    if (!item.ribbonText || !item.name || !item.productId) continue;

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
  const { items: rawItems, diag } = await fetchPromos();
  const deals = buildDeals(rawItems);
  console.log(`[Drinxit] ${deals.length} deals gevonden`);
  if (deals.length === 0) {
    if (diag?.emptyState) {
      console.warn("[Drinxit] Site meldt expliciet 'geen promoties' — geen fout, cache behouden");
      return { count: 0, emptyState: true, diag };
    }
    console.warn("[Drinxit] 0 deals gevonden — Supabase niet overschreven");
    return { count: 0, diag };
  }
  await supabaseWrite(deals);
  return { count: deals.length };
}
