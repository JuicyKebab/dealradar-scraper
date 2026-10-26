// Brico scraper — pure HTTP fetch + HTML parsing (geen Playwright nodig)
// SSR rendert 24 items per pagina. 6000+ promo producten over ~252 pagina's.
// Paginering via ?currentPage=N. Parallel batches van 10 pagina's.

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const BASE_URL = "https://www.brico.be/nl/collectie/all-nl";
const BASE_URL_FR = "https://www.brico.be/fr/collection/all-fr";
// Brico wisselde de filter-key naar "promotions" (2026-09). De oude "De beste prijzen"-vorm
// redirect nog wel, maar we gebruiken de canonieke key rechtstreeks.
const FILTER_PARAMS = "promotions=Promoties%2CExclusieve+promoties&filterKeys=promotions";
const FILTER_PARAMS_FR = "promotions=Promotions%2CPromotions+exclusives&filterKeys=promotions";
const HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
  "Accept-Language": "nl-BE,nl;q=0.9",
};
const PAGE_SIZE = 24;
const BATCH_SIZE = 10; // parallel requests per batch
const MAX_PAGES = 300;

const _MONTHS = ["januari","februari","maart","april","mei","juni","juli","augustus","september","oktober","november","december"];

function dutchDate(daysFromNow = 14) {
  const d = new Date();
  d.setDate(d.getDate() + daysFromNow);
  return `${d.getDate()} ${_MONTHS[d.getMonth()]}`;
}

function slugify(str) {
  return str.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function categorize(name) {
  const n = (name || "").toLowerCase();
  if (/tuin|plantenbak|gazon|heggen|snoeier|tuinslang|broeikast|serre|compost|potgrond|schors|tuinset|kweektafel|moestuin|grasmaaier|heggenschaar|bloempot|terras|parasol|haagplant|graszaad|onkruid|slakken|bodemverbeteraar|tuinmeubel|tuinstoel|tuintafel|vijver|irrigat|regenton|zwembad|trampoline|loungeset|loungestoel|ligstoel|zonnescherm|zonnetent|paviljoen|barbec|kamado|kussenbox|gaaspaneel|omheining|giardino|central park/.test(n)) return "Tuin";
  if (/lamp|armatuur|spot|downlight|ledstrip|lichtslang|plafondlamp|wandlamp|hanglamp|tl-buis|gloeilamp|eglo|led.*(light|licht|verlichting)|ceiling lamp|night light|dimmer/.test(n)) return "Verlichting";
  if (/muurverf|lakverf|grondverf|primer|beits|vernis|levis |sigma |perfection |schilders|verfrol|kwast/.test(n)) return "Verf";
  if (/boormachine|klopboor|schroefboor|boorhamer|cirkelzaag|decoupeerzaag|reciprozaag|verstekzaag|tafelzaag|kettingzaag|haakse slijper|schuurmachine|vlakschuurm|handpalmschuurm|schroevendraai|gereedschapsk|gereedschapsw|werkbank|schraag|lijnlaser|laserafstandsm|rolbandmaat|compressor|powerplus|makita|dewalt|dremel|futech|escalo|ladder|black\+decker/.test(n)) return "Gereedschap";
  if (/beton|cement|mortel|stabilis|grind|kiezel|leischilfer|kalksteen|dolomiet|isolatie|pir-plaat|golfplaat|betonplex|multiplex|gipsplaat|pu schuim|soudal|tec7|siliconenkit|montagekit|tegelkleefsof|voegmortel|coeck|aquaplan|sopratherm/.test(n)) return "Bouwmateriaal";
  if (/tegel(?!kleefsof)|laminaat|vinyl|clickvinyl|parket|kunstgras|plinten|ondervloer/.test(n)) return "Vloer & Wand";
  if (/douchekop|douchezuil|doucheset|mengkraan|keukenkraan|lavabo|wastafel|radiator|grohe|geberit|badkamer/.test(n) || ((/\btoilet\b|wc-/.test(n)) && !/papier|doek|blok|reinig|eend|gel/.test(n))) return "Badkamer & Sanitair";
  if (/stopcontact|schakelaar|zekering|kabelgoot|deurkruk|deurslot|scharnier|brievenbus|deurbel|videofoon|alarm|bewakingscamera/.test(n)) return "Elektra";
  if (/schoonmaak|wasmid|reinig|stofzuig|dweil|bezem|vuilzak|afvalzak|wasverzacht|vaatwas|stoomreinig|airconditioner|aircooler|ventilator|droogrek|kledingrek|schoenenrek|opbergrek|stellingkast|verlengsnoer/.test(n)) return "Huishouden";
  if (/valma|koelvloeistof|ijskrabber|cockpitspray|krasverwijder|velgenborstel|autowax|bandenzwart|bandenglans|ruitenrein|wash.and.shine|insect-free/.test(n)) return "Auto";
  return "Overig";
}

async function supabaseWrite(data) {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) throw new Error("Missing Supabase env vars");
  const res = await fetch(`${SUPABASE_URL}/rest/v1/cache`, {
    method: "POST",
    headers: {
      apikey: SUPABASE_SERVICE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
      "Content-Type": "application/json",
      Prefer: "resolution=merge-duplicates",
    },
    body: JSON.stringify({ key: "brico", data, updated_at: new Date().toISOString() }),
  });
  if (!res.ok) throw new Error(`Supabase write failed: ${res.status}`);
}

// Sinds sep 2026 rendert brico.be (React/Chakra) geen data-product-id/-name meer.
// Producten staan nu als JSON-LD ("@type":"Product") met sku/name/image/offers.price
// (= actieprijs, in euro's). De originele (doorstreepte) prijs staat enkel in de HTML
// als <del aria-label="EUR X">, gevolgd door <ins aria-label="EUR X"> (= actieprijs).
// JSON-LD-volgorde en del/ins-kaartvolgorde lopen gelijk; we koppelen per index met een
// guard (ins === offers.price). Bij volgorde-drift vallen we terug op de JSON-LD-actieprijs
// zonder korting (nooit een verzonnen %).
function parsePageHTML(html) {
  // 1. JSON-LD Product-blokken in DOM-volgorde
  const ldRe = /<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/g;
  const prods = [];
  let m;
  while ((m = ldRe.exec(html)) !== null) {
    let b;
    try { b = JSON.parse(m[1]); } catch { continue; }
    if (b && b["@type"] === "Product") {
      const price = b.offers && typeof b.offers.price === "number" ? b.offers.price : 0;
      prods.push({ sku: String(b.sku || ""), name: b.name || "", image: b.image || null, price });
    }
  }

  // 2. del/ins prijs-tokens in DOM-volgorde -> kaarten (ins = kaart, aangrenzende del ervoor = originele prijs)
  const tokRe = /<(ins|del)[^>]*aria-label="EUR ([\d.]+)"/g;
  const tokens = [];
  let t;
  while ((t = tokRe.exec(html)) !== null) tokens.push({ tag: t[1], value: parseFloat(t[2]) });
  const cards = [];
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i].tag === "ins") {
      const prev = tokens[i - 1];
      cards.push({ ins: tokens[i].value, del: prev && prev.tag === "del" ? prev.value : 0 });
    }
  }

  // 3. Zip JSON-LD-producten met kaarten per index; enkel korting overnemen als ins === offers.price
  return prods.map((p, i) => {
    const c = cards[i];
    let newPrice = p.price;
    let originalPrice = 0;
    if (c && c.ins === p.price) {
      newPrice = c.ins;
      originalPrice = c.del || 0;
    }
    return { sku: p.sku, name: p.name, newPrice, originalPrice, image: p.image };
  });
}

async function fetchPage(pageNum, baseUrl = BASE_URL, filterParams = FILTER_PARAMS) {
  const url = `${baseUrl}?currentPage=${pageNum}&${filterParams}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  try {
    const res = await fetch(url, { headers: HEADERS, signal: controller.signal });
    if (!res.ok) throw new Error(`Page ${pageNum}: HTTP ${res.status}`);
    const html = await res.text();
    return parsePageHTML(html);
  } finally {
    clearTimeout(timeout);
  }
}

export async function scrapeBrico() {
  // Pagina 1 ophalen om totaal te bepalen
  const page1Url = `${BASE_URL}?${FILTER_PARAMS}`;
  const c1 = new AbortController();
  const t1 = setTimeout(() => c1.abort(), 20_000);
  const res1 = await fetch(page1Url, { headers: HEADERS, signal: c1.signal });
  clearTimeout(t1);
  if (!res1.ok) throw new Error(`Page 1: HTTP ${res1.status}`);
  const html1 = await res1.text();

  // Zoek totaal producten
  const totalMatch = html1.match(/([\d.]+)\s*PRODUCTEN/i);
  const totalProducts = totalMatch ? parseInt(totalMatch[1].replace(/\./g, "")) : 0;
  const totalPages = totalProducts > 0 ? Math.min(Math.ceil(totalProducts / PAGE_SIZE), MAX_PAGES) : MAX_PAGES;
  console.log(`[brico] ${totalProducts} producten gevonden, ${totalPages} pagina's`);

  // Parse pagina 1
  const allProducts = new Map();
  const page1Products = parsePageHTML(html1);
  for (const p of page1Products) allProducts.set(p.sku, p);
  console.log(`[brico] Pagina 1: ${page1Products.length} items (totaal ${allProducts.size})`);

  // Pagina 2..N in batches van BATCH_SIZE
  let consecutiveEmpty = 0;
  for (let batchStart = 2; batchStart <= totalPages; batchStart += BATCH_SIZE) {
    const pageNums = [];
    for (let p = batchStart; p < batchStart + BATCH_SIZE && p <= totalPages; p++) pageNums.push(p);

    const results = await Promise.allSettled(pageNums.map(p => fetchPage(p)));

    let batchNew = 0;
    for (let i = 0; i < results.length; i++) {
      if (results[i].status === "rejected") {
        console.log(`[brico] Pagina ${pageNums[i]} fout: ${results[i].reason.message}`);
        continue;
      }
      const batch = results[i].value;
      let pageNew = 0;
      for (const p of batch) {
        if (!allProducts.has(p.sku)) {
          allProducts.set(p.sku, p);
          pageNew++;
        }
      }
      batchNew += pageNew;
    }

    console.log(`[brico] Pagina ${pageNums[0]}-${pageNums[pageNums.length - 1]}: ${batchNew} nieuw (totaal ${allProducts.size})`);

    if (batchNew === 0) {
      consecutiveEmpty++;
      if (consecutiveEmpty >= 3) {
        console.log(`[brico] 3 lege batches, stoppen`);
        break;
      }
    } else {
      consecutiveEmpty = 0;
    }
  }

  console.log(`[brico] Totaal: ${allProducts.size} unieke producten`);

  // Fetch FR product names (parallel batches, same pagination)
  const frNames = new Map();
  try {
    const frPage1Url = `${BASE_URL_FR}?${FILTER_PARAMS_FR}`;
    const fc1 = new AbortController();
    const ft1 = setTimeout(() => fc1.abort(), 20_000);
    const fRes1 = await fetch(frPage1Url, { headers: HEADERS, signal: fc1.signal });
    clearTimeout(ft1);
    if (fRes1.ok) {
      const fHtml1 = await fRes1.text();
      const frTotalMatch = fHtml1.match(/([\d.]+)\s*PRODUITS/i);
      const frTotalPages = frTotalMatch ? Math.min(Math.ceil(parseInt(frTotalMatch[1].replace(/\./g, "")) / PAGE_SIZE), MAX_PAGES) : totalPages;
      for (const p of parsePageHTML(fHtml1)) frNames.set(p.sku, p.name);
      for (let bs = 2; bs <= frTotalPages; bs += BATCH_SIZE) {
        const pns = [];
        for (let fp = bs; fp < bs + BATCH_SIZE && fp <= frTotalPages; fp++) pns.push(fp);
        const fResults = await Promise.allSettled(pns.map(fp => fetchPage(fp, BASE_URL_FR, FILTER_PARAMS_FR)));
        let batchNew = 0;
        for (const r of fResults) {
          if (r.status === "fulfilled") for (const p of r.value) { if (!frNames.has(p.sku)) { frNames.set(p.sku, p.name); batchNew++; } }
        }
        if (batchNew === 0 && bs > 2) break;
      }
    }
  } catch (err) {
    console.log(`[brico] FR fetch fout: ${err.message}`);
  }
  console.log(`[brico] FR namen: ${frNames.size}`);

  const deals = [];
  const seen = new Set();
  const validUntil = dutchDate(14);

  for (const p of allProducts.values()) {
    const sku = p.sku || slugify(p.name);
    const id = `brico-${sku}`;
    if (seen.has(id)) continue;
    seen.add(id);

    const originalPrice = p.originalPrice || 0;
    const newPrice = p.newPrice || 0;
    if (newPrice <= 0 && originalPrice <= 0) continue;

    const savings = originalPrice > newPrice && originalPrice > 0 && newPrice > 0
      ? Math.round((1 - newPrice / originalPrice) * 100)
      : 0;

    deals.push({
      id,
      store: "Brico",
      storeColor: "#e30613",
      storeLogo: "BR",
      emoji: "\uD83D\uDD28",
      item: p.name,
      ...(frNames.has(p.sku) && { item_fr: frNames.get(p.sku) }),
      deal: savings > 0 ? `-${savings}%` : "Promotie",
      category: categorize(p.name),
      originalPrice,
      newPrice: newPrice || originalPrice,
      savings,
      image: p.image || null,
      hot: savings >= 30,
      validUntil,
    });
  }

  console.log(`[brico] ${deals.length} deals na filtering`);

  if (deals.length === 0) {
    throw new Error("Geen Brico deals gevonden");
  }

  await supabaseWrite(deals);
  console.log(`[brico] ${deals.length} deals opgeslagen`);
  return { total: deals.length };
}
