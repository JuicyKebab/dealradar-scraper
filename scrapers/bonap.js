// Bon'Ap scraper — Publitas folder via de spreads.json text-laag (geen vision/credits nodig).
// Publitas levert per pagina een `text`-veld (eigen tekstextractie): productnamen, prijzen
// (promo: X/kg, A/100 g - B/100 g), promo-mechanismen (1+1 GRATIS, 2DE SCHAAL AAN -50%, -NN%).
// De foldertekst is een platgeslagen lay-out; we segmenteren op naam-regels en parsen
// conservatief (mechanisme OF prijsdaling ≥10%). Folder bevat meerdere weken → per-pagina
// einddatum, verlopen weken worden overgeslagen.

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const _DAYS   = ["zo", "ma", "di", "wo", "do", "vr", "za"];
const _MONTHS = ["januari", "februari", "maart", "april", "mei", "juni", "juli", "augustus", "september", "oktober", "november", "december"];

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";
const _PUBLITAS_HOST = "https://view.publitas.com";

function fmtDutch(d) {
  return `${_DAYS[d.getDay()]} ${d.getDate()} ${_MONTHS[d.getMonth()]}`;
}

function dutchDate(daysFromNow = 14) {
  const d = new Date();
  d.setDate(d.getDate() + daysFromNow);
  return fmtDutch(d);
}

// "t.e.m. (di) DD/MM" -> Date (jaargrens: een maand ver in het verleden telt als volgend jaar)
function parseEndDate(str) {
  const m = str.match(/t\.e\.m\.\s*(?:\w{2}\s+)?(\d{1,2})\/(\d{1,2})/i);
  if (!m) return null;
  const day = parseInt(m[1]);
  const month = parseInt(m[2]) - 1;
  const now = new Date();
  const year = month < now.getMonth() - 2 ? now.getFullYear() + 1 : now.getFullYear();
  return new Date(year, month, day);
}

function slugify(str) {
  return str.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
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
    body: JSON.stringify({ key: "bonap", data, updated_at: new Date().toISOString() }),
  });
  if (!res.ok) throw new Error(`Supabase write failed: ${res.status}`);
}

// --- Tekst-parser -----------------------------------------------------------

const KW = /^(PROMO|GRATIS|WEEK\b|RAP NAAR|MAX\.|max\.|Vanaf\b|NIEUW|IN 'T SCHAP|t\.e\.m\.|2DE SCHAAL|1\s*\+\s*1|2\s*\+\s*1|GEEN|OP=OP|Bon'Ap)/i;
const FOOTER = /(promoprijzen|prijzen|vari[eë]ren|naargelang|geldig|voorraad|assortiment|winkelpunt|\bfolder\b|wijzigen|marktsituatie|zolang|strekt|vermeld|kan per)/i;
const isPrice = (l) => /\d+[.,]\d+/.test(l) || /^\d+\s*$/.test(l) || /^(kg|g|\d+\s*g|\d+\s*kg|100\s*g|±.*)/i.test(l) || /^\d+\s*x\b/i.test(l);
const isName = (l) => {
  if (l.length < 3 || l.length > 40) return false;
  if (KW.test(l) || FOOTER.test(l) || isPrice(l)) return false;
  if (/^[+•-]/.test(l)) return false;
  if (l.split(/\s+/).length > 5) return false; // zinnen weren
  return /^[A-ZÀ-ÖØ-Þ][a-zà-öø-ÿ]/.test(l) && /[a-zà-ÿ]{3}/.test(l);
};
const isNameCont = (l) => /^[a-zà-ÿ]/.test(l) && !isPrice(l) && !KW.test(l) && !FOOTER.test(l) && l.split(/\s+/).length <= 2 && l.length < 22;

function dedupWords(s) {
  const seen = new Set();
  return s.split(/\s+/).filter(w => { const k = w.toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; }).join(" ");
}

function categorize(name) {
  const n = name.toLowerCase();
  if (/kaas|melk|yogh|boter|room/.test(n)) return "Zuivel";
  if (/brood|taart|koek|gebak|donut|pistol|wrap|buffet/.test(n)) return "Bakkerij & Snacks";
  if (/pasta|dagschotel|schotel|nestje|lasagne/.test(n)) return "Diepvries";
  return "Vlees & Vis";
}

function parseMechanism(b) {
  let m;
  if ((m = b.match(/(\d+)\s*kg\s*\+\s*(\d+)\s*kg\s*gratis/i))) { const base = +m[1], free = +m[2]; return { deal: `${m[1]}kg + ${m[2]}kg gratis`, sav: Math.round(free / (base + free) * 100) }; }
  if ((m = b.match(/(\d+)\s*g\s*\+\s*(\d+)\s*g\s*gratis/i)))   { const base = +m[1], free = +m[2]; return { deal: `${m[1]}g + ${m[2]}g gratis`, sav: Math.round(free / (base + free) * 100) }; }
  if (/2\s*\+\s*1\s*gratis/i.test(b)) return { deal: "2+1 GRATIS", sav: 33 };
  if (/1\s*\+\s*1\s*gratis/i.test(b)) return { deal: "1+1 GRATIS", sav: 50 };
  if ((m = b.match(/2de\s+schaal\s+aan\s*-?\s*(\d+)\s*%/i))) return { deal: `2e schaal aan -${m[1]}%`, sav: +m[1] };
  if ((m = b.match(/-\s*(\d+)\s*%/))) return { deal: `-${m[1]}%`, sav: +m[1] };
  return null;
}

function parsePrices(block) {
  let newP = 0, origP = 0;
  const promoKg = block.match(/promo:\s*(\d+[.,]\d+)\s*\/\s*kg/i);
  const allKg = [...block.matchAll(/(\d+[.,]\d+)\s*\/\s*kg/gi)].map(x => parseFloat(x[1].replace(",", ".")));
  const per100 = block.match(/(\d+[.,]\d+)\s*\/\s*100\s*g\s*-\s*(\d+[.,]\d+)\s*\/\s*100\s*g/i);
  const perStuk = block.match(/(\d+[.,]\d+)\s*\/\s*stuk\b/i);
  if (promoKg) {
    newP = parseFloat(promoKg[1].replace(",", "."));
    const origs = allKg.filter(v => v > newP);
    if (origs.length) origP = Math.max(...origs);
  } else if (per100) {
    origP = parseFloat(per100[1].replace(",", ".")) * 10;
    newP = parseFloat(per100[2].replace(",", ".")) * 10;
  } else if (allKg.length >= 2) {
    const s = [...allKg].sort((a, b) => a - b); newP = s[0]; origP = s[s.length - 1];
  } else if (perStuk) {
    newP = parseFloat(perStuk[1].replace(",", "."));
  }
  return { newP: Math.round(newP * 100) / 100, origP: Math.round(origP * 100) / 100 };
}

function parsePageDeals(lines, validUntil) {
  const out = [];
  const nameIdx = [];
  for (let i = 0; i < lines.length; i++) if (isName(lines[i])) nameIdx.push(i);
  for (let k = 0; k < nameIdx.length; k++) {
    const start = nameIdx[k];
    const end = k + 1 < nameIdx.length ? nameIdx[k + 1] : lines.length;
    let name = lines[start], j = start + 1, joined = 0;
    while (j < end && isNameCont(lines[j]) && joined < 2 && (name.length + lines[j].length) < 40) { name += " " + lines[j]; j++; joined++; }
    name = dedupWords(name.replace(/\s*•.*$/, "").replace(/[,;]\s*$/, "").replace(/\s+/g, " ").trim());
    if (name.length < 3) continue;
    name = name.charAt(0).toUpperCase() + name.slice(1);
    const block = lines.slice(start, end).join(" ").replace(/\s+/g, " ");
    const mech = parseMechanism(block);
    const { newP, origP } = parsePrices(block);
    const hasDrop = origP > 0 && newP > 0 && origP > newP;
    const priceSav = hasDrop ? Math.round((origP - newP) / origP * 100) : 0;
    // Conservatief: mechanisme -> altijd; anders enkel bij prijsdaling ≥10%
    if (!mech && priceSav < 10) continue;
    const deal = mech ? mech.deal : "Promoprijs";
    const savings = mech ? mech.sav : priceSav;
    if (savings <= 0) continue;
    out.push({
      id: `bonap-${slugify(name)}`,
      store: "Bon'Ap",
      storeColor: "#B71C1C",
      storeLogo: "B",
      item: name,
      deal,
      category: categorize(name),
      originalPrice: origP,
      newPrice: newP,
      savings,
      validUntil,
      hot: savings >= 30,
    });
  }
  return out;
}

export async function scrapeBonap() {
  // 1. Publitas folder-URL ophalen van bonap.be (voorkeur: promofolder "ba_pf")
  const res = await fetch("https://www.bonap.be/nl/folder", {
    headers: { "User-Agent": UA },
    signal: AbortSignal.timeout(15_000),
  });
  const html = await res.text();
  const urls = [...html.matchAll(/https:\/\/view\.publitas\.com\/buurtslagers-bonap\/[^"'\s\\]+/g)].map(m => m[0]);
  const chosen = urls.find(u => /_ba_pf_/i.test(u)) || urls[0];
  if (!chosen) throw new Error("Could not find Publitas URL on bonap.be/nl/folder");
  const folderBase = chosen.replace(/\/(page\/\d+|spreads\.json)\/?$/i, "").replace(/\/$/, "");
  console.log(`[bonap] folder: ${folderBase}`);

  // 2. spreads.json direct via HTTP (geen Playwright meer nodig)
  const sres = await fetch(`${folderBase}/spreads.json`, {
    headers: { "User-Agent": UA },
    signal: AbortSignal.timeout(20_000),
  });
  if (!sres.ok) throw new Error(`spreads.json HTTP ${sres.status}`);
  const spreads = await sres.json();
  if (!Array.isArray(spreads) || !spreads.length) throw new Error("Could not capture Bon'Ap Publitas folder data");

  // 3. Per-pagina tekst + einddatum verzamelen (carry-forward voor datumloze pagina's)
  const pages = [];
  for (const sp of spreads) for (const pg of sp.pages || []) pages.push(pg.text || "");
  const dates = pages.map(parseEndDate);
  for (let i = 0; i < dates.length; i++) {
    if (dates[i]) continue;
    let f = null;
    for (let j = i - 1; j >= 0; j--) if (dates[j]) { f = dates[j]; break; }
    if (!f) for (let j = i + 1; j < dates.length; j++) if (dates[j]) { f = dates[j]; break; }
    dates[i] = f;
  }

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const fallbackUntil = dutchDate(14);

  // 4. Parse + dedup, verlopen weken overslaan
  const seen = new Set();
  const deals = [];
  for (let i = 0; i < pages.length; i++) {
    const d = dates[i];
    if (d && d < today) continue; // verlopen week overslaan
    const validUntil = d ? fmtDutch(d) : fallbackUntil;
    const lines = pages[i].split("\n").map(l => l.trim()).filter(Boolean);
    for (const deal of parsePageDeals(lines, validUntil)) {
      if (seen.has(deal.id)) continue;
      seen.add(deal.id);
      deals.push(deal);
    }
  }

  console.log(`[bonap] ${deals.length} deals na parsing`);
  if (deals.length === 0) throw new Error("Geen Bon'Ap deals gevonden");

  await supabaseWrite(deals);
  return { total: deals.length };
}
