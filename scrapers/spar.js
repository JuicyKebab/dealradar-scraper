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

function mapSparItem(item, i) {
  const p = item.promotion;
  if (!p?.promoTitle) return null;
  const normalPrice = parseFloat(`${p.normalPrice?.beforeDecimal || 0}.${String(p.normalPrice?.afterDecimal || "00").padStart(2, "0")}`);
  const promoPrice = parseFloat(`${p.promoPrice?.beforeDecimal || 0}.${String(p.promoPrice?.afterDecimal || "00").padStart(2, "0")}`);
  const savings = normalPrice > promoPrice && promoPrice > 0
    ? Math.round((1 - promoPrice / normalPrice) * 100) : 0;
  const description = [p.promoDescription, p.quantity].filter(Boolean).join(" ");
  return {
    id: 8000 + i,
    store: "Spar", storeColor: "#007A33", storeLogo: "S",
    item: p.promoTitle,
    deal: savings > 0 ? `-${savings}%` : "Aanbieding",
    category: "Overig",
    originalPrice: normalPrice,
    newPrice: promoPrice || normalPrice,
    savings,
    emoji: "🛒",
    validUntil: sparDateToDutch(p.formattedEndDate),
    hot: savings >= 30,
    description,
    image: p.promoAssetPath ? `https://www.mijnspar.be${p.promoAssetPath}` : null,
  };
}

// Probeer de API direct op te halen met de bekende URL-patronen
async function fetchSparDirect() {
  const HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
    "Accept": "application/json, text/plain, */*",
    "Accept-Language": "nl-BE,nl;q=0.9",
    "Referer": "https://www.mijnspar.be/nl/promoties",
  };

  const candidates = [
    "https://www.mijnspar.be/content/spar/nl/promoties/jcr:content/root/responsivegrid/responsivegrid/responsivegrid/filter_list_store_sp.model.json",
    "https://www.mijnspar.be/nl/promoties/filter_list_store_sp.model.json",
    "https://www.mijnspar.be/nl/promoties.filter_list_store_sp.model.json",
    "https://www.mijnspar.be/content/spar/be/nl/promoties/jcr:content/root/responsivegrid/filter_list_store_sp.model.json",
  ];

  for (const url of candidates) {
    try {
      const res = await fetch(url, { headers: HEADERS });
      if (!res.ok) continue;
      const data = await res.json();
      const results = data.results || data.promotions || (Array.isArray(data) ? data : null);
      if (results?.length > 0) {
        console.log(`[Spar] Direct API: ${results.length} deals via ${url}`);
        return results;
      }
    } catch { /* probeer volgende */ }
  }
  return null;
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
