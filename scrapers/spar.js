// Spar Belgium (mijnspar.be) — directe API + Playwright fallback
const _DDAYS = ["zo", "ma", "di", "wo", "do", "vr", "za"];
const _DMONTHS = ["januari", "februari", "maart", "april", "mei", "juni", "juli", "augustus", "september", "oktober", "november", "december"];

function dutchDate(daysFromNow = 7) {
  const d = new Date();
  d.setDate(d.getDate() + daysFromNow);
  return `${_DDAYS[d.getDay()]} ${d.getDate()} ${_DMONTHS[d.getMonth()]}`;
}

function sparDateToDutch(formatted) {
  // "25/03/2026" → "wo 25 maart"
  if (!formatted) return dutchDate(7);
  const [day, month, year] = formatted.split("/");
  if (!day || !month) return dutchDate(7);
  const d = new Date(year || new Date().getFullYear(), Number(month) - 1, Number(day));
  return `${_DDAYS[d.getDay()]} ${day} ${_DMONTHS[Number(month) - 1]}`;
}

function sparTimestampToDutch(ts) {
  if (!ts) return dutchDate(7);
  const d = new Date(ts);
  return `${_DDAYS[d.getDay()]} ${d.getDate()} ${_DMONTHS[d.getMonth()]}`;
}

function sparPrice(obj) {
  if (!obj || obj.empty) return null;
  const bd = obj.beforeDecimal;
  const ad = obj.afterDecimal;
  if (bd === null && ad === null) return null;
  return parseFloat(`${bd || 0}.${String(ad || "0").padStart(2, "0")}`);
}

function sparCategory(tags) {
  const catTag = (tags || []).find(t => t.tagID?.includes("/category/"));
  if (catTag) {
    const name = catTag.title || catTag.name || "";
    return name.charAt(0).toUpperCase() + name.slice(1);
  }
  return "Overig";
}

function sparDealLabel(tags, savings) {
  const labelTag = (tags || []).find(t => t.tagID?.includes("/labels/"));
  if (labelTag?.title) return labelTag.title;
  return savings > 0 ? `-${savings}%` : "Aanbieding";
}

function sparEmoji(category) {
  const map = { zuivel: "🥛", kaas: "🧀", vlees: "🥩", groenten: "🥦", fruit: "🍎", dranken: "🥤", brood: "🍞", diepvries: "🧊", snacks: "🍿" };
  const lower = (category || "").toLowerCase();
  for (const [k, e] of Object.entries(map)) { if (lower.includes(k)) return e; }
  return "🛒";
}

function mapSparItem(item, i) {
  const p = item.promotion;
  if (!p?.promoTitle) return null;

  const normalPrice = sparPrice(p.normalPrice);
  const promoPrice = sparPrice(p.promoPrice);
  const savings = normalPrice && promoPrice && normalPrice > promoPrice
    ? Math.round((1 - promoPrice / normalPrice) * 100) : 0;

  const category = sparCategory(item.localizedTags);
  const dealLabel = sparDealLabel(item.localizedTags, savings);
  const description = [p.promoDescription, p.quantity].filter(Boolean).join(" ");

  return {
    id: 8000 + i,
    store: "Spar", storeColor: "#007A33", storeLogo: "S",
    item: p.promoTitle,
    deal: dealLabel,
    category,
    originalPrice: normalPrice ?? promoPrice ?? 0,
    newPrice: promoPrice ?? normalPrice ?? 0,
    savings,
    emoji: sparEmoji(category),
    validUntil: sparTimestampToDutch(p.endDate),
    hot: savings >= 30,
    description,
    image: p.promoAssetPath ? `https://www.mijnspar.be${p.promoAssetPath}` : null,
  };
}

const SPAR_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
  "Accept": "application/json, text/plain, */*",
  "Accept-Language": "nl-BE,nl;q=0.9",
  "Referer": "https://www.mijnspar.be/nl/promoties",
};

async function fetchSparEndpoint(url) {
  try {
    const res = await fetch(url, { headers: SPAR_HEADERS });
    if (!res.ok) return [];
    const data = await res.json();
    return data.results || [];
  } catch { return []; }
}

// Haal alle promo sub-pagina's op via sitemap en zoek filter_list endpoints
async function discoverSparEndpoints() {
  const known = [
    "https://www.mijnspar.be/content/spar/nl/promoties/jcr:content/root/responsivegrid/responsivegrid/responsivegrid/filter_list_store_sp.model.json",
  ];
  try {
    const sitemapRes = await fetch("https://www.mijnspar.be/sitemap.xml", { headers: SPAR_HEADERS });
    if (!sitemapRes.ok) return known;
    const xml = await sitemapRes.text();
    const promoUrls = [...xml.matchAll(/<loc>([^<]*\/promoties[^<]*)<\/loc>/g)].map(m => m[1]);
    console.log(`[Spar] Sitemap: ${promoUrls.length} promo-pagina's gevonden`);

    // Haal HTML van elke promo sub-pagina en zoek filter_list endpoints
    const endpoints = new Set(known);
    await Promise.all(promoUrls.map(async (pageUrl) => {
      try {
        const res = await fetch(pageUrl, { headers: { ...SPAR_HEADERS, Accept: "text/html" } });
        if (!res.ok) return;
        const html = await res.text();
        const matches = html.matchAll(/\/content\/spar[^\s"'<>]*filter_list[^\s"'<>]*\.json/g);
        for (const m of matches) endpoints.add("https://www.mijnspar.be" + m[0]);
      } catch { /* skip */ }
    }));
    return [...endpoints];
  } catch (e) {
    console.log("[Spar] Sitemap scan fout:", e.message);
    return known;
  }
}

async function fetchSparDirect() {
  const endpoints = await discoverSparEndpoints();
  console.log(`[Spar] ${endpoints.length} endpoints gevonden`);

  const allResults = [];
  const seenUuids = new Set();
  await Promise.all(endpoints.map(async (url) => {
    const results = await fetchSparEndpoint(url);
    if (results.length > 0) console.log(`[Spar] ${results.length} deals via ...${url.slice(-60)}`);
    for (const r of results) {
      const key = r.uuid || r.promotion?.uuid || JSON.stringify(r.promotion?.promoTitle);
      if (!seenUuids.has(key)) { seenUuids.add(key); allResults.push(r); }
    }
  }));
  return allResults.length > 0 ? allResults : null;
}

async function scrapeSpar(browser, maxResults = 500) {
  // Probeer eerst directe API
  const direct = await fetchSparDirect();
  if (direct && direct.length > 0) {
    return direct.slice(0, maxResults).map(mapSparItem).filter(Boolean);
  }

  // Playwright: intercept + vastleggen van de exacte URL voor directe hergebruik
  const page = await browser.newPage();
  try {
    await page.setExtraHTTPHeaders({ "Accept-Language": "nl-BE,nl;q=0.9" });

    let sparData = null;
    let interceptedUrl = null;
    let interceptedHeaders = null;

    page.on("response", async (response) => {
      const url = response.url();
      if (!url.includes("filter_list_store_sp.model.json")) return;
      try {
        const data = await response.json();
        if (data.results?.length > 0) {
          sparData = data;
          interceptedUrl = url;
          // Kopieer bruikbare request headers
          const reqHeaders = response.request().headers();
          interceptedHeaders = {
            "User-Agent": reqHeaders["user-agent"] || "Mozilla/5.0",
            "Accept": reqHeaders["accept"] || "application/json",
            "Accept-Language": "nl-BE,nl;q=0.9",
            "Referer": "https://www.mijnspar.be/nl/promoties",
          };
          console.log(`[Spar] Intercepted: ${url.slice(0, 120)}, ${data.results.length} results`);
        }
      } catch { /* skip */ }
    });

    await page.goto("https://www.mijnspar.be/nl/promoties", { waitUntil: "domcontentloaded", timeout: 45000 });
    await page.waitForTimeout(5000);

    if (!sparData) {
      console.log("[Spar] API niet onderschept");
      return [];
    }

    let allResults = [...sparData.results];
    const total = sparData.totalCount ?? sparData.total ?? sparData.count ?? null;
    console.log(`[Spar] Eerste batch: ${allResults.length} van ${total ?? "?"} totaal`);

    // Als er meer resultaten zijn dan ontvangen, haal de rest op via de intercepted URL
    if (total && total > allResults.length && interceptedUrl && interceptedHeaders) {
      const baseUrl = interceptedUrl.split("?")[0];
      const pageSize = allResults.length;
      let offset = pageSize;

      while (offset < total) {
        try {
          const url = `${baseUrl}?offset=${offset}&limit=${pageSize}`;
          const res = await fetch(url, { headers: interceptedHeaders });
          if (!res.ok) break;
          const data = await res.json();
          const batch = data.results || [];
          if (batch.length === 0) break;
          console.log(`[Spar] Pagina offset=${offset}: ${batch.length} extra`);
          allResults.push(...batch);
          offset += batch.length;
        } catch (e) {
          console.log("[Spar] Paginering fout:", e.message);
          break;
        }
      }
    }

    console.log(`[Spar] Totaal: ${allResults.length} deals`);
    return allResults.slice(0, maxResults).map(mapSparItem).filter(Boolean);
  } finally {
    await page.close();
  }
}

module.exports = { scrapeSpar };
