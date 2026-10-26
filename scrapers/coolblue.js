// Coolblue scraper — Awin productfeed (CSV)
// Geen Playwright/Brightdata nodig — simpele HTTP fetch + CSV parse
import { createGunzip } from "zlib";
import { Readable } from "stream";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const FEED_API_KEY = process.env.AWIN_FEED_API_KEY || "7999ad0879c2efabeadeafe3a6a5181b";
const FEED_ID_NL = "96638";
const MIN_SAVINGS_PCT = 5;
const COLUMNS = "aw_deep_link,product_name,aw_product_id,search_price,aw_image_url,merchant_image_url,brand_name,base_price";
const FEED_URL = `https://productdata.awin.com/datafeed/download/apikey/${FEED_API_KEY}/language/nl/fid/${FEED_ID_NL}/columns/${COLUMNS}/format/csv/delimiter/%2C/`;

function parseCSVLine(line) {
  const fields = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') { current += '"'; i++; }
      else inQuotes = !inQuotes;
    } else if (ch === "," && !inQuotes) {
      fields.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  fields.push(current);
  return fields;
}

// Merken die bijna altijd elektronica zijn
const ELECTRONICS_BRANDS = /\b(samsung|apple|sony|philips|lg|asus|acer|lenovo|hp|dell|logitech|jbl|bose|sonos|soundcore|anker|belkin|tp-link|netgear|corsair|razer|msi|gigabyte|epson|canon|nikon|fujifilm|dji|gopro|garmin|fitbit|polar|suunto|oura|eufy|eufycam|ring|google nest|amazon echo|roku|bowers|wilkins|marshall|steelseries|imou|hyperx)\b/i;
const HOUSEHOLD_BRANDS = /\b(bosch|miele|siemens|tefal|boretti|etna|kitchenaid|dyson|nilfisk|rowenta|wisberg|veripart|vortech|homebase)\b/i;
// Productwoorden per categorie
const ELECTRONICS_WORDS = /\b(laptop|notebook|macbook|chromebook|telefoon|phone|iphone|smartphone|tablet|ipad|screenprotector|hoesje|cover|back cover|protective|galaxy|pixel|watch|buds|earbuds|pods|airpods|koptelefoon|headset|headphone|speaker|soundbar|subwoofer|tv|televisie|monitor|beeldscherm|qled|oled|mini-led|led\b|4k|8k|uhd|bravia|printer|scanner|inkt|toner|camera|lens|drone|router|wifi|mesh|netwerk|adapter|hub|docking|charger|oplader|powerbank|magsafe|usb-c|hdmi|playstation|xbox|nintendo|controller|gaming|console|ssd|hdd|geheugen|ram|opslag|muis|keyboard|toetsenbord|azerty|webcam|projector|beamer|e-reader|kindle|streamer|chromecast|apple tv|fire tv|nas|server|modem|switch\b|extender|repeater|dashcam|action cam|vr|oculus|meta quest|smart home|thermostat|rookmelder|deurbel|beveiligingscamera|tracker|airtag|stylus|pencil|stand\b|houder|dock|kabel|lader|accu|batterij|geheugenkaart|sd.?kaart)\b/i;

function categorize(name) {
  const n = name.toLowerCase();
  // Specifieke niet-elektronica eerst
  if (/wasmachine|droger|vaatwasser|koelkast|vriezer|oven|magnetron|fornuis|afzuigkap|kookplaat/.test(n)) return "Huishouden";
  if (/stofzuiger|strijkijzer|airfryer|blender|mixer|keukenmachine|waterkoker|broodrooster|koffie|espresso|nespresso|dolce gusto/.test(n)) return "Huishouden";
  if (/wasmiddel|ontkalk|reinig|schoonmaak|filter\b/.test(n)) return "Huishouden";
  if (/lamp|verlichting|ledlamp|lightstrip|hue\b/.test(n)) return "Huishouden";
  if (/matras|kussen|dekbed|beddengoed|bedframe/.test(n)) return "Huishouden";
  if (/koekenpan|hapjespan|braadpan|steelpan|pannenset|wok\b/.test(n)) return "Huishouden";
  if (HOUSEHOLD_BRANDS.test(n)) return "Huishouden";
  if (/scheerapparaat|trimmer|epileer|f.hn|stijltang|krultang|haardroger|beauty/.test(n)) return "Verzorging";
  if (/\bbraun\b|babyliss/.test(n)) return "Verzorging";
  if (/tandenborstel|oral-b|waterflosser|sonicare/.test(n)) return "Verzorging";
  if (/zonnebank|ipl|ontharing/.test(n)) return "Verzorging";
  if (/fiets|e-bike|helm|fietslamp|wielren/.test(n)) return "Sport";
  if (/fitness|smartwatch|horloge|sporthorloge/.test(n)) return "Sport";
  if (/grasmaaier|heggenschaar|hogedrukreiniger|bladblazer|kettingzaag|robotmaaier/.test(n)) return "Tuin";
  if (/bbq|barbecue|tuinslang/.test(n)) return "Tuin";
  if (/kinderwagen|autostoel|babyfoon|babymonitor/.test(n)) return "Baby";
  if (/lego|playmobil|speelgoed/.test(n)) return "Speelgoed";
  if (/\bwhoop\b/.test(n)) return "Sport";
  if (/gamestoel|bureaust/.test(n)) return "Elektronica";
  // Elektronica: merken of productwoorden
  if (ELECTRONICS_BRANDS.test(n)) return "Elektronica";
  if (ELECTRONICS_WORDS.test(n)) return "Elektronica";
  // Opslag-hoeveelheden (128gb, 256gb, 1tb) zijn bijna altijd elektronica
  if (/\d+\s*(gb|tb)\b/.test(n)) return "Elektronica";
  return "Overig";
}

async function supabaseWrite(key, data) {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) throw new Error("supabaseWrite: env vars ontbreken");
  const res = await fetch(`${SUPABASE_URL}/rest/v1/cache`, {
    method: "POST",
    headers: {
      apikey: SUPABASE_SERVICE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
      "Content-Type": "application/json",
      Prefer: "resolution=merge-duplicates,return=minimal",
    },
    body: JSON.stringify({ key, data, updated_at: new Date().toISOString() }),
  });
  if (!res.ok) console.error(`supabaseWrite(${key}) failed: ${res.status}`);
}

async function fetchAndDecompress(url) {
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) throw new Error(`Feed HTTP ${res.status}`);

  const buf = Buffer.from(await res.arrayBuffer());
  // Check gzip magic bytes
  if (buf[0] === 0x1f && buf[1] === 0x8b) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      const gunzip = createGunzip();
      gunzip.on("data", (chunk) => chunks.push(chunk));
      gunzip.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
      gunzip.on("error", reject);
      Readable.from(buf).pipe(gunzip);
    });
  }
  return buf.toString("utf-8");
}

export async function scrapeCoolblue() {
  console.log("[coolblue] Fetching Awin feed...");
  const text = await fetchAndDecompress(FEED_URL);

  const lines = text.split("\n").filter(l => l.trim());
  if (lines.length < 2) throw new Error("Feed is leeg");
  console.log(`[coolblue] Feed: ${lines.length - 1} producten`);

  // Kolommen: aw_deep_link(0), product_name(1), aw_product_id(2), search_price(3),
  //           aw_image_url(4), merchant_image_url(5), brand_name(6), base_price(7)
  const deals = [];
  for (let i = 1; i < lines.length; i++) {
    const fields = parseCSVLine(lines[i]);
    if (fields.length < 8) continue;
    const [deepLink, name, productId, priceStr, awImage, merchantImage, brand, basePriceStr] = fields;
    if (!deepLink || !productId) continue;

    const price = parseFloat(priceStr);
    const basePrice = parseFloat(basePriceStr);
    if (!basePrice || !price || basePrice <= price) continue;

    const savings = Math.round((basePrice - price) / basePrice * 100);
    if (savings < MIN_SAVINGS_PCT) continue;

    const image = (merchantImage || awImage || "").replace(/^"|"$/g, "");

    // Valideer affiliate URL protocol
    const safeLink = deepLink.startsWith("https://") ? deepLink : null;

    deals.push({
      id: `coolblue-${productId}`,
      store: "Coolblue",
      storeColor: "#0090e3",
      storeLogo: "CB",
      item: name.replace(/^"|"$/g, "").slice(0, 200),
      deal: `Van \u20AC${basePrice.toFixed(2)} voor \u20AC${price.toFixed(2)}`,
      category: categorize(name),
      originalPrice: basePrice,
      newPrice: price,
      savings,
      image,
      hot: savings >= 30,
      affiliateUrl: safeLink,
      brand: (brand || "").replace(/^"|"$/g, ""),
    });
  }

  deals.sort((a, b) => b.savings - a.savings);
  console.log(`[coolblue] ${deals.length} deals (>=${MIN_SAVINGS_PCT}% korting)`);

  await supabaseWrite("coolblue", deals);

  return { total: deals.length };
}
