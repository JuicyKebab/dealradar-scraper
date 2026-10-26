// Aveve scraper — tuin, dier & lekkers promoties via HTTP fetch + HTML parsing

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const _DAYS   = ["zo","ma","di","wo","do","vr","za"];
const _MONTHS = ["januari","februari","maart","april","mei","juni","juli","augustus","september","oktober","november","december"];

function dutchDate(daysFromNow = 14) {
  const d = new Date();
  d.setDate(d.getDate() + daysFromNow);
  return `${_DAYS[d.getDay()]} ${d.getDate()} ${_MONTHS[d.getMonth()]}`;
}

function slugify(str) {
  return str.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function categorize(name) {
  const n = (name || "").toLowerCase();
  if (/hond|honden|puppy/.test(n)) return "Dier";
  if (/kat|katten|kitten/.test(n)) return "Dier";
  if (/paard|paarden/.test(n)) return "Dier";
  if (/vogel|vis|knaagdier|konijn|hamster/.test(n)) return "Dier";
  if (/tuin|plant|bloem|pot|grond|mest|zaai|snoei|gazon|gras|heg/.test(n)) return "Tuin";
  if (/maaier|robot|segway|bosmaaier|snoeischaar|machine|ketting/.test(n)) return "Tuin";
  if (/bbq|barbecue|grill|houtskool|briketten/.test(n)) return "Tuin";
  if (/serre|kas|broei/.test(n)) return "Tuin";
  if (/meel|bloem|suiker|chocola|bakken|gist|vanille|fondant|glazuur/.test(n)) return "Bakkerij & Snacks";
  if (/koek|biscuit|chips|noot|noten|snoep|praline/.test(n)) return "Bakkerij & Snacks";
  if (/confituur|honing|siroop|spread/.test(n)) return "Droogwaren";
  if (/pasta|rijst|linzen|bonen/.test(n)) return "Droogwaren";
  if (/bier|wijn|drank|sap|limonade|water/.test(n)) return "Dranken";
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
    body: JSON.stringify({ key: "aveve", data, updated_at: new Date().toISOString() }),
  });
  if (!res.ok) throw new Error(`Supabase write failed: ${res.status}`);
}

async function fetchPage(page) {
  const url = `https://www.aveve.be/promoties?product_list_limit=48&p=${page}`;
  const res = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36" },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`Aveve fetch p${page}: ${res.status}`);
  return res.text();
}

function parseDeals(html, validUntil) {
  const deals = [];
  const cards = html.split(/class="item product product-item product_addtocart_form/);

  for (let i = 1; i < cards.length; i++) {
    const card = cards[i].split(/class="item product product-item product_addtocart_form/)[0];

    const name = card.match(/product-item-link[^>]*>([^<]+)/)?.[1]?.trim();
    if (!name || name.length < 2) continue;

    const finalPrice = parseFloat(card.match(/data-price-amount="([^"]+)"[\s\S]*?data-price-type="finalPrice"/)?.[1] || "0");
    const oldPrice = parseFloat(card.match(/data-price-amount="([^"]+)"[\s\S]*?data-price-type="oldPrice"/)?.[1] || "0");
    const productId = card.match(/data-price-box="product-id-(\d+)"/)?.[1];
    const img = card.match(/src="(https:\/\/www\.aveve\.be\/media\/catalog\/[^"]+)"/)?.[1] || null;
    const url = card.match(/href="(https:\/\/www\.aveve\.be\/[^"]+)"/)?.[1] || null;

    // Badge tekst
    const badgeBlock = card.match(/<svg[\s\S]*?<\/svg>[\s\S]*?<\/div>\s*<\/div>/)?.[0] || "";
    const spans = badgeBlock.match(/<span[^>]*>([^<]*)<\/span>/g)?.map(s => s.replace(/<[^>]+>/g, "").trim()).filter(Boolean) || [];
    const badgeText = spans.join(" ");

    // Korting percentage
    const pctMatch = badgeText.match(/-(\d+(?:[,.]\d+)?)\s*%/);
    let savings = pctMatch ? Math.round(parseFloat(pctMatch[1].replace(",", "."))) : 0;

    // Gratis deal (1+1, 2+1, 5+1, etc.)
    const gratisMatch = badgeText.match(/(\d+)\s*\+\s*(\d+)/);
    let dealText = "";
    if (gratisMatch) {
      const buy = parseInt(gratisMatch[1]);
      const free = parseInt(gratisMatch[2]);
      dealText = `${buy}+${free} gratis`;
      if (!savings) savings = Math.round(free / (buy + free) * 100);
    } else if (pctMatch) {
      dealText = `-${pctMatch[1].replace(",", ".")}%`;
    } else if (/op\s*=\s*op/i.test(badgeText)) {
      dealText = "Op = Op";
    } else if (/gratis/i.test(badgeText) && !gratisMatch) {
      dealText = "Gratis cadeau";
    } else {
      dealText = "Promo";
    }

    // Originele prijs berekenen
    let originalPrice = oldPrice > 0 ? oldPrice : 0;
    if (!originalPrice && savings > 0 && finalPrice > 0) {
      originalPrice = parseFloat((finalPrice / (1 - savings / 100)).toFixed(2));
    }

    // Skip deals zonder prijs
    if (finalPrice <= 0) continue;
    // Skip "GRATIS garage" en andere accessoire-deals zonder korting
    if (!savings && !gratisMatch && !pctMatch && !/op\s*=\s*op/i.test(badgeText)) continue;

    deals.push({
      id: `aveve-${productId || slugify(name)}`,
      store: "Aveve",
      storeColor: "#4a8c2a",
      storeLogo: "AV",
      item: name,
      deal: dealText,
      category: categorize(name),
      originalPrice: originalPrice || finalPrice,
      newPrice: finalPrice,
      savings,
      validUntil,
      hot: savings >= 40,
      image: img,
      productUrl: url,
    });
  }

  return deals;
}

export async function scrapeAveve() {
  const validUntil = dutchDate(14);
  const allDeals = [];
  const seen = new Set();

  // Fetch pagina 1 om totaal pagina's te bepalen
  const html1 = await fetchPage(1);
  const pageLinks = html1.match(/\?p=(\d+)/g) || [];
  const maxPage = Math.max(1, ...pageLinks.map(l => parseInt(l.match(/\d+/)[0])));
  console.log(`[aveve] ${maxPage} pages detected`);

  allDeals.push(...parseDeals(html1, validUntil));

  // Fetch overige pagina's
  for (let p = 2; p <= Math.min(maxPage, 20); p++) {
    try {
      const html = await fetchPage(p);
      allDeals.push(...parseDeals(html, validUntil));
    } catch (err) {
      console.error(`[aveve] page ${p} error:`, err.message);
    }
  }

  // Dedup op ID
  const unique = [];
  for (const deal of allDeals) {
    if (seen.has(deal.id)) continue;
    seen.add(deal.id);
    unique.push(deal);
  }

  console.log(`[aveve] ${unique.length} unique deals`);
  if (unique.length === 0) throw new Error("Geen deals geparseerd");

  await supabaseWrite(unique);
  return { total: unique.length };
}
