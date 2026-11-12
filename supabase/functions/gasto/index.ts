// Función "gasto" de Mi Día · registra automáticamente los pagos con Apple Pay.
// La llama la automatización de Atajos del iPhone con el enlace personal (?t=...).
// Se llama con la cabecera Authorization: Bearer <clave pública anon> ("Verify JWT" activado).
import { createClient } from "jsr:@supabase/supabase-js@2";


function parseAmount(v) {
  if (typeof v === "number") return Math.round(Math.abs(v) * 100) / 100;
  let s = String(v ?? "").replace(/[^\d,.\-]/g, "");
  if (!s) return NaN;
  const lc = s.lastIndexOf(","), ld = s.lastIndexOf(".");
  if (lc > -1 && ld > -1) {
    // el último separador es el decimal
    s = lc > ld ? s.replace(/\./g, "").replace(",", ".") : s.replace(/,/g, "");
  } else if (lc > -1) {
    s = /,\d{1,2}$/.test(s) ? s.replace(/\./g, "").replace(",", ".") : s.replace(/,/g, "");
  } else if (ld > -1 && /\.\d{3}$/.test(s) && !/\.\d{1,2}$/.test(s)) {
    s = s.replace(/\./g, "");
  }
  const n = Math.abs(Number(s));
  return isFinite(n) ? Math.round(n * 100) / 100 : NaN;
}

const CAT_RULES = [
  ["Comida y súper", ["mercadona", "carrefour", "lidl", "aldi", "eroski", "alcampo", "consum", "hipercor", "ahorramas", "bonpreu", "caprabo", "condis", "supermerc", "supercor", "froiz", "gadis", "covirán", "coviran", "masymas", "spar", "fruter", "panader", "carnicer", "pescader", "dia %", "dia retail", "supermercados dia", "^dia$"]],
  ["Ocio", ["restaur", "bar ", "cafe", "café", "cafeter", "starbucks", "mcdonald", "burger", "kfc", "telepizza", "domino", "foster", "100 montaditos", "vips", "glovo", "just eat", "uber eats", "deliveroo", "cine", "yelmo", "cinesa", "teatro", "ticketmaster", "entradas", "steam", "playstation", "xbox", "nintendo"]],
  ["Transporte", ["repsol", "cepsa", "galp", "shell", "bp ", "petronor", "ballenoil", "plenoil", "gasolin", "renfe", "ouigo", "iryo", "alsa", "metro", "emt", "tmb", "uber", "cabify", "bolt", "freenow", "free now", "parking", "aparcam", "empark", "autopista", "peaje", "ryanair", "vueling", "iberia", "aena", "taxi"]],
  ["Salud", ["farmacia", "parafarm", "clinica", "clínica", "dental", "dentist", "hospital", "optica", "óptica", "fisio", "sanitas", "adeslas", "dkv", "mapfre salud", "veterin"]],
  ["Ropa", ["zara", "primark", "h&m", "hm ", "pull&bear", "pull and bear", "mango", "bershka", "stradivarius", "massimo dutti", "decathlon", "nike", "adidas", "springfield", "cortefiel", "lefties", "kiabi", "shein", "zalando", "foot locker", "jd sports", "uniqlo"]],
  ["Suscripciones", ["netflix", "spotify", "apple.com", "apple services", "icloud", "amazon prime", "prime video", "hbo", "max.com", "disney", "youtube", "google one", "dazn", "movistar plus", "filmin", "chatgpt", "openai", "claude", "anthropic", "microsoft", "adobe", "audible"]],
  ["Suministros", ["iberdrola", "endesa", "naturgy", "totalenergies", "holaluz", "repsol luz", "canal de isabel", "aguas de", "movistar", "vodafone", "orange", "digi", "simyo", "pepephone", "masmovil", "jazztel", "yoigo", "lowi", "o2 "]],
  ["Vivienda", ["ikea", "leroy merlin", "bricomart", "bricodepot", "brico", "ferreter", "conforama", "jysk", "maisons du monde", "zara home", "comunidad de propietarios"]],
];

function categorize(merchant) {
  const m = ` ${String(merchant || "").toLowerCase().trim()} `;
  const t = m.trim();
  for (const [cat, keys] of CAT_RULES) {
    for (const k of keys) {
      if (k.startsWith("^")) { if (new RegExp(k).test(t)) return cat; }
      else if (k.endsWith(" %")) { if (t.startsWith(k.slice(0, -2) + " ")) return cat; }
      else if (m.includes(k)) return cat;
    }
  }
  return "Otros";
}

function madridDate(ms) {
  const f = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Madrid", year: "numeric", month: "2-digit", day: "2-digit" });
  return f.format(new Date(ms));
}

function cleanMerchant(s) {
  return String(s ?? "").replace(/\s+/g, " ").trim().slice(0, 80);
}


const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type", "Access-Control-Allow-Methods": "POST, GET, OPTIONS" };
const reply = (msg: string, status = 200) => new Response(msg, { status, headers: { ...CORS, "Content-Type": "text/plain; charset=utf-8" } });
const eur = (v: number) => new Intl.NumberFormat("es-ES", { style: "currency", currency: "EUR" }).format(v);

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  const url = new URL(req.url);
  let body: any = {};
  try { const txt = await req.text(); if (txt) { try { body = JSON.parse(txt); } catch { body = Object.fromEntries(new URLSearchParams(txt)); } } } catch (_) { /* sin cuerpo */ }
  const q = (k: string) => body[k] ?? url.searchParams.get(k);
  const token = String(q("t") ?? q("token") ?? "").trim();
  if (token.length < 20) return reply("Falta tu enlace personal de Mi Día.", 401);

  let key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  if (!key) { try { const k = JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS") ?? "{}"); key = Object.values(k)[0] as string ?? ""; } catch (_) { /* sin clave */ } }
  const sb = createClient(Deno.env.get("SUPABASE_URL")!, key);

  const { data: tok } = await sb.from("ingest_tokens").select("user_id").eq("token", token).maybeSingle();
  if (!tok) return reply("Enlace no válido. Genera uno nuevo en Mi Día → Finanzas → Apple Pay.", 401);

  const amount = parseAmount(q("importe") ?? q("amount") ?? q("Importe") ?? q("Amount"));
  if (!(amount > 0)) return reply("No se ha recibido un importe válido.", 400);
  const merchant = cleanMerchant(q("comercio") ?? q("merchant") ?? q("Comercio") ?? q("Merchant")) || "Pago con Apple Pay";
  const card = cleanMerchant(q("tarjeta") ?? q("card") ?? "");
  const now = Date.now();

  // evitar duplicados: mismo importe y comercio en los últimos 2 minutos
  const since = new Date(now - 120000).toISOString();
  const { data: recent } = await sb.from("items").select("id,data").eq("user_id", tok.user_id).eq("deleted", false).gte("updated_at", since);
  if ((recent ?? []).some((r: any) => r.data?.kind === "txn" && r.data?.source === "applepay" && Number(r.data?.amount) === amount && r.data?.note === merchant)) {
    return reply(`Ya estaba registrado: ${eur(amount)} · ${merchant}`);
  }

  const cat = categorize(merchant);
  const id = "tx_ap_" + now.toString(36) + Math.random().toString(36).slice(2, 7);
  const data = { kind: "txn", type: "out", amount, cat, date: madridDate(now), note: merchant, source: "applepay", card: card || undefined, created: now, _u: now };
  const { error } = await sb.from("items").insert({ user_id: tok.user_id, id, data, deleted: false });
  if (error) return reply("No se pudo guardar el gasto: " + error.message, 500);
  return reply(`Gasto registrado: ${eur(amount)} · ${merchant} (${cat})`);
});
