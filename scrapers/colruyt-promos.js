// Colruyt promotions scraper — gets discount percentages from website API
// Strategy: load page to capture auth headers, then paginate via direct Node.js fetch.
// The user-promotions/by-date-range API returns benefitPercentage per promotion.
import { chromium } from "playwright";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

async function supabaseWrite(data) {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) throw new Error("Missing Supabase env vars");
  const payload = JSON.stringify({ key: "colruyt_promos", data, updated_at: new Date().toISOString() });
  console.log(`[colruyt-promos] Supabase payload size: ${(payload.length / 1024).toFixed(1)}KB`);
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), 30000);
      const res = await fetch(`${SUPABASE_URL}/rest/v1/cache`, {
        method: "POST",
        headers: {
          apikey: SUPABASE_SERVICE_KEY,
          Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
          "Content-Type": "application/json",
          Prefer: "resolution=merge-duplicates",
        },
        body: payload,
        signal: ac.signal,
      });
      clearTimeout(timer);
      if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
      return;
    } catch (err) {
      console.log(`[colruyt-promos] Supabase write attempt ${attempt}/3 failed: ${err.message}`);
      if (attempt === 3) throw new Error(`Supabase write failed after 3 attempts: ${err.message}`);
      await new Promise(r => setTimeout(r, 3000));
    }
  }
}

export async function scrapeColruytPromos() {
  const sbUser = process.env.BRIGHTDATA_SB_USER;
  const sbPass = process.env.BRIGHTDATA_SB_PASS;
  if (!sbUser || !sbPass) throw new Error("Missing BRIGHTDATA_SB_USER / BRIGHTDATA_SB_PASS");

  const endpointURL = `wss://${sbUser}:${sbPass}@brd.superproxy.io:9222`;
  let browser, ctx, page;

  let totalFound = 0;
  let requestHeaders = null;
  let requestBody = null;
  let firstPagePromos = [];

  try {
    browser = await chromium.connectOverCDP(endpointURL);
    ctx = await browser.newContext();
    page = await ctx.newPage();

    // Intercept the first user-promotions request to capture auth headers + body
    page.on("request", (req) => {
      if (req.url().includes("user-promotions/by-date-range") && !requestHeaders) {
        requestHeaders = req.headers();
        requestBody = req.postData();
        console.log("[colruyt-promos] captured auth headers");
      }
    });

    page.on("response", async (res) => {
      if (res.url().includes("user-promotions/by-date-range") && firstPagePromos.length === 0) {
        try {
          const json = await res.json();
          totalFound = json.totalPromotionFound || 0;
          firstPagePromos = json.promotions || [];
          console.log(`[colruyt-promos] first page: ${firstPagePromos.length} promos, total: ${totalFound}`);
        } catch {}
      }
    });

    console.log("[colruyt-promos] Loading colruyt.be/nl/acties...");
    await page.goto("https://www.colruyt.be/nl/acties", {
      waitUntil: "domcontentloaded",
      timeout: 90_000,
    });
    await page.waitForTimeout(8000);

    if (!requestHeaders || !requestBody) {
      return { ok: false, error: "no-api-request", pageTitle: await page.title().catch(() => "?") };
    }

    // Close browser early — we have the headers, rest is pure Node.js fetch
    await page.close().catch(() => {});
    await ctx.close().catch(() => {});
    await browser.close();
    browser = null;

    // Paginate via direct Node.js fetch with captured auth headers
    const allPromos = [...firstPagePromos];
    const bodyObj = JSON.parse(requestBody);
    const pageSize = bodyObj.commonParameters?.size || 23;
    const apiUrl = "https://apip.colruyt.be/gateway/emec.colruyt.protected.bffsvc/cg/nl/api/user-promotions/by-date-range";

    for (let p = 2; p <= Math.ceil(totalFound / pageSize); p++) {
      const body = {
        ...bodyObj,
        commonParameters: { ...bodyObj.commonParameters, page: p },
      };
      try {
        const res = await fetch(apiUrl, {
          method: "POST",
          headers: { ...requestHeaders, "content-type": "application/json" },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(10000),
        });
        if (!res.ok) {
          console.log(`[colruyt-promos] page ${p}: ${res.status}`);
          break;
        }
        const json = await res.json();
        const promos = json.promotions || [];
        allPromos.push(...promos);
        console.log(`[colruyt-promos] page ${p}: ${promos.length} promos (total: ${allPromos.length})`);
        if (promos.length < pageSize) break;
      } catch (err) {
        console.log(`[colruyt-promos] page ${p}: ${err.message}`);
        break;
      }
    }

    console.log(`[colruyt-promos] Collected ${allPromos.length}/${totalFound}`);

    // Deduplicate
    const seen = new Set();
    const uniquePromos = allPromos.filter(p => {
      if (!p.promotionId || seen.has(p.promotionId)) return false;
      seen.add(p.promotionId);
      return true;
    });

    // Build enrichment map: promotionId -> benefit data + linked product IDs
    const enrichment = {};
    for (const promo of uniquePromos) {
      const id = promo.promotionId;
      const benefit = (promo.benefit || [])[0] || {};
      const pct = benefit.benefitPercentage || 0;
      const minLimit = benefit.minLimit || 1;

      let label;
      if (pct === 100 && minLimit === 2) label = "1+1 GRATIS";
      else if (pct === 100 && minLimit === 3) label = "2+1 GRATIS";
      else if (pct === 100) label = "GRATIS";
      else if (pct > 0 && minLimit > 1) label = `-${pct}% vanaf ${minLimit} st`;
      else if (pct > 0) label = `-${pct}%`;
      else label = "Promo";

      // Collect all linked product identifiers
      const productIds = new Set();
      for (const field of ["linkedTechnicalArticleNumber", "linkedCommercialArticleNumber"]) {
        if (Array.isArray(promo[field])) promo[field].forEach(v => productIds.add(String(v)));
      }
      const hr = promo.highestSalesRank;
      if (hr?.technicalArticleNumber) productIds.add(String(hr.technicalArticleNumber));
      if (hr?.commercialArticleNumber) productIds.add(String(hr.commercialArticleNumber));

      enrichment[id] = {
        pct,
        minQty: minLimit,
        label,
        topPromo: promo.topPromo || false,
        productIds: [...productIds],
        brands: promo.brandList || [],
        totalProducts: promo.totalLinkedProduct || 0,
      };
    }

    console.log(`[colruyt-promos] ${Object.keys(enrichment).length} promotions mapped`);

    if (Object.keys(enrichment).length > 0) {
      try {
        await supabaseWrite(enrichment);
        console.log("[colruyt-promos] saved to Supabase");
      } catch (err) {
        console.log("[colruyt-promos] Supabase write failed, returning data in response:", err.message);
      }
    }

    return {
      ok: true,
      totalFound,
      collected: uniquePromos.length,
      enrichmentKeys: Object.keys(enrichment).length,
      sampleLabels: Object.values(enrichment).slice(0, 10).map(e => e.label),
      enrichment,
    };
  } finally {
    if (browser) {
      await page?.close().catch(() => {});
      await ctx?.close().catch(() => {});
      await browser.close();
    }
  }
}
