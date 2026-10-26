import Anthropic from "@anthropic-ai/sdk";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;

const BATCH_SIZE = 50;
const CONCURRENCY = 5;
const SAVE_EVERY = 5; // upsert na elke 5 batches

const ALL_CACHE_KEYS = [
  "colruyt", "deals", "lidl", "renmans", "bakkersonline", "drinxit", "prikentik",
  "alvo", "amazingoriental", "tanger", "ah", "carrefour", "delhaize", "okay", "bioplanet",
  "callens", "vercammen", "dillen", "rechtvantveld", "versleverancier", "groentebroer",
  "intermarche", "bonap", "delitraiteur", "dockx", "butchermc", "vandamme", "dugardeyn",
  "dries", "keurslager", "verschooren", "delaet", "amic", "slagersonline",
  "interflower", "floralux", "quisquater",
  "hubo", "coolblue", "brico",
  "euroshop", "action", "aveve", "tomco", "artencraft", "medimarket", "farmaline",
];

async function supabaseRead(keys) {
  const keyList = keys.map(k => encodeURIComponent(k)).join(",");
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/cache?key=in.(${keyList})&select=key,data`,
    { headers: { apikey: SUPABASE_SERVICE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_KEY}` } }
  );
  if (!res.ok) throw new Error(`Supabase read ${res.status}`);
  return res.json();
}

async function supabaseUpsert(map) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/cache`, {
    method: "POST",
    headers: {
      apikey: SUPABASE_SERVICE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
      "Content-Type": "application/json",
      Prefer: "resolution=merge-duplicates",
    },
    body: JSON.stringify({ key: "product_translations", data: map, updated_at: new Date().toISOString() }),
  });
  if (!res.ok) throw new Error(`Supabase upsert ${res.status}: ${await res.text()}`);
}

const PROMPT = `You translate Dutch (Belgian) product names to French and English.

Rules:
- KEEP brand names exactly as-is (Coca-Cola, Kinder, Ferrero, Dove, etc.)
- KEEP quantities, units, sizes, percentages exactly as-is (500 g, 1,5 l, 33 cl, 2x, 3st)
- KEEP model numbers, article codes exactly as-is
- Only translate the Dutch descriptive words
- For French: use Belgian French natural product names
- For English: use common English product names
- If a name is already French or English or is purely a brand name, return it unchanged

Input: JSON array of Dutch product names.
Output: JSON array of objects, same order, each: {"fr":"French name","en":"English name"}
No explanation, only the JSON array.`;

async function translateBatch(client, names) {
  const resp = await client.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 8192,
    messages: [{ role: "user", content: `${PROMPT}\n\n${JSON.stringify(names)}` }],
  });
  const text = resp.content[0]?.text || "[]";
  const match = text.match(/\[[\s\S]*\]/);
  if (!match) throw new Error("No JSON array in response");
  const results = JSON.parse(match[0]);
  if (results.length !== names.length) throw new Error(`Length mismatch: ${results.length} vs ${names.length}`);
  return results;
}

export async function batchTranslate() {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) throw new Error("Missing Supabase env vars");
  if (!ANTHROPIC_KEY) throw new Error("Missing ANTHROPIC_API_KEY");

  const client = new Anthropic({ apiKey: ANTHROPIC_KEY });

  // 1. Read existing translations
  const [transRow] = await supabaseRead(["product_translations"]);
  const existing = transRow?.data || {};
  console.log(`[batch-translate] Existing translations: ${Object.keys(existing).length}`);

  // 2. Read all deal cache keys
  const rows = await supabaseRead(ALL_CACHE_KEYS);
  const itemSet = new Set();
  for (const row of rows) {
    if (!Array.isArray(row.data)) continue;
    for (const deal of row.data) {
      if (!deal.item) continue;
      const key = deal.item.trim().toLowerCase();
      if (key && !existing[key]) itemSet.add(key);
    }
  }

  const todo = [...itemSet];
  console.log(`[batch-translate] ${todo.length} names to translate (${Object.keys(existing).length} already done)`);
  if (todo.length === 0) return { translated: 0, total: Object.keys(existing).length };

  // 3. Batch translate with concurrency
  const map = { ...existing };
  let done = 0, errors = 0, batchesSinceSave = 0;

  for (let i = 0; i < todo.length; i += BATCH_SIZE * CONCURRENCY) {
    const chunk = [];
    for (let j = 0; j < CONCURRENCY && i + j * BATCH_SIZE < todo.length; j++) {
      const start = i + j * BATCH_SIZE;
      const batch = todo.slice(start, start + BATCH_SIZE);
      chunk.push(
        translateBatch(client, batch)
          .then(results => {
            for (let k = 0; k < batch.length; k++) {
              const r = results[k];
              if (r?.fr || r?.en) map[batch[k]] = { fr: r.fr || batch[k], en: r.en || batch[k] };
            }
            done += batch.length;
          })
          .catch(err => {
            console.error(`[batch-translate] Batch error at ${start}: ${err.message}`);
            errors += batch.length;
          })
      );
    }
    await Promise.all(chunk);
    batchesSinceSave++;

    if (batchesSinceSave >= SAVE_EVERY || i + BATCH_SIZE * CONCURRENCY >= todo.length) {
      await supabaseUpsert(map);
      batchesSinceSave = 0;
      console.log(`[batch-translate] Progress: ${done}/${todo.length} (errors: ${errors}), saved ${Object.keys(map).length} total`);
    }
  }

  return { translated: done, errors, total: Object.keys(map).length };
}
