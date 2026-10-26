// Hubo scraper — via Algolia API (geen Playwright/proxy nodig)
// Mechanisme: haal Algolia search key op via Hubo BFF, daarna direct Algolia bevragen.
// Key verloopt na ~30 min — wordt per scrape-run opgehaald.

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const ALGOLIA_APP_ID = "IAT3OBS59Q";
const ALGOLIA_INDEX = "prod_hubo_products_nl_BE";
const ALGOLIA_URL = `https://${ALGOLIA_APP_ID.toLowerCase()}-dsn.algolia.net/1/indexes/${ALGOLIA_INDEX}/query`;
const BFF_PARAMS_URL = "https://api.hubo.be/web/Hubo_Base_Store/search/parameters";

const _MONTHS = ["januari","februari","maart","april","mei","juni","juli","augustus","september","oktober","november","december"];
const _DAYS = ["zo","ma","di","wo","do","vr","za"];

// Resolve Algolia mainImages ({code, medias:[{format,url}]}) naar één URL-string vóór opslag.
// Vroeger werd het volledige object bewaard (~1.6KB/deal) -> hubo cache-blob 11MB -> I/O-pieken op
// 1GB Supabase. Spiegelt pickHuboImage() in app/lib/huboImage.js (string blijft daar passthrough).
const HUBO_IMG_PREF = ["800x600", "440x330", "1920x1440", "302x226", "146x109", "110x82"];
function resolveHuboImage(mainImages) {
  const img = Array.isArray(mainImages) ? mainImages[0] : mainImages;
  if (!img || !Array.isArray(img.medias)) return typeof img === "string" ? img : null;
  const medias = img.medias.filter(m => m && m.url && m.format !== "BigImage");
  return HUBO_IMG_PREF.map(f => medias.find(m => m.format === f)?.url).find(Boolean) || medias[0]?.url || null;
}

function categorize(name) {
  const n = (name || "").toLowerCase();
  if (/tuin|plantenbak|gazon|heggen|snoeier|tuinslang|serre|compost|potgrond|schors|grasmaaier|heggenschaar|bloempot|terras|parasol|graszaad|onkruid|tuinmeubel|tuinstoel|tuintafel|vijver|irrigat|regenton|zwembad|trampoline|loungeset|loungestoel|ligstoel|zonnescherm|zonnetent|paviljoen|barbec|kamado|kussenbox|gaaspaneel|garden plus|woodlands|gardena|lawnmaster|intex|keter tuinhuis|keter tuinbox|keter tuinkast|blokhut|hangstoel|dianthus|narcis|terrasplant/.test(n)) return "Tuin";
  if (/lamp|armatuur|spot|downlight|ledstrip|lichtslang|plafondlamp|wandlamp|hanglamp|tl-buis|gloeilamp|eglo|led.*(light|licht|verlichting)|ceiling lamp|night light|spiegellamp|pixel lamp/.test(n)) return "Verlichting";
  if (/muurverf|lakverf|grondverf|primer|beits|vernis|superdek|rust-oleum|levis |sigma |perfection |schilderskit|verfrol|kwast/.test(n)) return "Verf";
  if (/boormachine|klopboor|schroefboor|boorhamer|cirkelzaag|decoupeerzaag|reciprozaag|verstekzaag|tafelzaag|kettingzaag|haakse slijper|schuurmachine|vlakschuurm|handpalmschuurm|schroevendraai|gereedschapsk|gereedschapsw|werkbank|schraag|lijnlaser|laserafstandsm|rolbandmaat|compressor|powerplus|makita|dewalt|dremel|futech|escalo|ladder|black\+decker|sortmaster|bitset|ratelset/.test(n)) return "Gereedschap";
  if (/beton|cement|mortel|stabilis|grind|kiezel|leischilfer|kalksteen|dolomiet|isolatie|pir-plaat|golfplaat|betonplex|pu schuim|soudal|tec7|siliconenkit|coeck|aquaplan|sopratherm/.test(n)) return "Bouwmateriaal";
  if (/tegel(?!kleefsof)|laminaat|vinyl|clickvinyl|parket|kunstgras|plinten|ondervloer/.test(n)) return "Vloer & Wand";
  if (/douchekop|douchezuil|doucheset|mengkraan|keukenkraan|lavabo|wastafel|radiator|grohe|geberit|badkamer/.test(n) || ((/\btoilet\b|wc-/.test(n)) && !/papier|doek|blok|reinig|eend|gel/.test(n))) return "Badkamer & Sanitair";
  if (/stopcontact|schakelaar|zekering|kabelgoot|deurkruk|deurslot|scharnier|brievenbus|deurbel|videofoon|alarm|bewakingscamera/.test(n)) return "Elektra";
  if (/stofzuig|vloerreinig|stoomreinig|airconditioner|aircooler|ventilator|droogrek|kledingrek|schoenenrek|opbergrek|stellingkast|verlengsnoer|wandrek/.test(n)) return "Huishouden";
  if (/valma|koelvloeistof|ijskrabber|cockpitspray|krasverwijder|velgenborstel|autowax|bandenzwart|bandenglans|ruitenrein|wash.and.shine|insect-free/.test(n)) return "Auto";
  return "Overig";
}

function isoToDutch(dateStr) {
  if (!dateStr) return "";
  const d = new Date(dateStr.slice(0, 10));
  if (isNaN(d)) return "";
  return `${_DAYS[d.getDay()]} ${d.getDate()} ${_MONTHS[d.getMonth()]}`;
}

async function getAlgoliaKey() {
  const res = await fetch(BFF_PARAMS_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      "Origin": "https://www.hubo.be",
      "Referer": "https://www.hubo.be/",
      "Accept-Language": "nl",
      "LANGUAGE": "nl_BE",
    },
    body: JSON.stringify({ userToken: null }),
  });
  if (!res.ok) throw new Error(`BFF /search/parameters fout: ${res.status}`);
  const data = await res.json();
  if (!data.searchApiKey) throw new Error("Geen searchApiKey in BFF response");
  return data.searchApiKey;
}

async function queryAlgolia(apiKey, page) {
  const res = await fetch(ALGOLIA_URL, {
    method: "POST",
    headers: {
      "x-algolia-application-id": ALGOLIA_APP_ID,
      "x-algolia-api-key": apiKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      filters: "categoryPageIds:promo",
      hitsPerPage: 200,
      page,
      attributesToRetrieve: ["name", "sku", "brand", "price", "url", "mainImages", "categoryName"],
    }),
  });
  if (!res.ok) throw new Error(`Algolia fout: ${res.status}`);
  return res.json();
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
    body: JSON.stringify({ key: "hubo", data: deals, updated_at: new Date().toISOString() }),
  });
  if (!res.ok) throw new Error(`Supabase write failed: ${res.status} ${await res.text()}`);
}

export async function scrapeHubo() {
  const apiKey = await getAlgoliaKey();
  console.log("[hubo] Algolia key opgehaald");

  const deals = [];
  const seen = new Set();
  let page = 0;

  while (true) {
    const data = await queryAlgolia(apiKey, page);
    const hits = data.hits || [];
    const nbPages = data.nbPages || 1;

    for (const h of hits) {
      const sku = h.sku;
      if (!sku || seen.has(sku)) continue;

      const p = h.price || {};
      if (!p.strikethroughPrice || !p.discountPercentage) continue;

      const promos = p.promotions || [];
      const relevantPromo = promos.find(x =>
        x.promotionType === "FOLDERPRIJS" || x.promotionType === "ACTIEPRIJS"
      );
      if (!relevantPromo) continue;
      if (p.currentPrice == null) continue;

      seen.add(sku);

      const savings = Math.round(p.discountPercentage);
      const validTo = relevantPromo.validTo ? isoToDutch(relevantPromo.validTo) : "";
      const image = resolveHuboImage(h.mainImages);

      deals.push({
        id: `hubo-${sku}`,
        store: "Hubo",
        storeColor: "#F37021",
        storeLogo: "HB",
        emoji: "🔨",
        item: h.name || "Onbekend",
        deal: `-${savings}%`,
        category: categorize(h.name || ""),
        originalPrice: p.strikethroughPrice,
        newPrice: p.currentPrice,
        savings,
        validUntil: validTo,
        hot: savings >= 30,
        image,
        url: h.url || null,
      });
    }

    console.log(`[hubo] pagina ${page + 1}/${nbPages}: ${hits.length} hits, ${deals.length} deals tot nu`);
    page++;
    if (page >= nbPages) break;
  }

  console.log(`[hubo] ${deals.length} deals totaal`);

  if (deals.length > 0) {
    await supabaseWrite(deals);
  }

  return { total: deals.length };
}
