// Función "notify" de Mi Día · envía notificaciones push (recordatorios y avisos de presupuesto)
// Se ejecuta cada 15 minutos desde la base de datos (pg_cron). Desactiva "Verify JWT" en sus ajustes.
import webpush from "npm:web-push@3.6.7";
import { createClient } from "jsr:@supabase/supabase-js@2";

// Lógica de avisos de Mi Día (compartida entre la prueba en Node y la función de Supabase).
// Calcula qué avisos tocan para un usuario en un momento dado, en su zona horaria.

function localParts(ms, tz) {
  const f = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  const p = Object.fromEntries(f.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}` };
}
function addDaysStr(ds, n) {
  const [y, m, d] = ds.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return t.toISOString().slice(0, 10);
}
function dow(ds) { const [y, m, d] = ds.split("-").map(Number); return new Date(Date.UTC(y, m - 1, d)).getUTCDay(); }
function dom(ds) { return Number(ds.slice(8, 10)); }
function lastDom(ds) { const [y, m] = ds.split("-").map(Number); return new Date(Date.UTC(y, m, 0)).getUTCDate(); }
function asMs(ds, hm) { const [y, m, d] = ds.split("-").map(Number); const [h, mi] = (hm || "00:00").split(":").map(Number); return Date.UTC(y, m - 1, d, h, mi); }

function occursOn(ev, ds) {
  if (!ev.date || ds < ev.date) return false;
  const r = ev.repeat || "none";
  if (r === "none") return ds === ev.date;
  if (r === "daily") return true;
  if (r === "weekdays") { const w = dow(ds); return w >= 1 && w <= 5; }
  if (r === "weekly") return dow(ds) === dow(ev.date);
  if (r === "monthly") return dom(ds) === Math.min(dom(ev.date), lastDom(ds));
  return false;
}
const eur = (v) => new Intl.NumberFormat("es-ES", { style: "currency", currency: "EUR" }).format(v);
const longDate = (ds) => { const [y, m, d] = ds.split("-").map(Number); return new Intl.DateTimeFormat("es-ES", { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" }).format(new Date(Date.UTC(y, m - 1, d))); };

/** items: [{id, ...data}] sin borrados. Devuelve [{key, title, body, tag, extraKeys?}] */
function computeDue(items, nowMs, tz, opts) {
  const o = Object.assign({ slots: ["00:00", "09:00", "18:00"] }, opts || {});
  const now = localParts(nowMs, tz);
  const nowL = asMs(now.date, now.time);
  const out = [];
  const events = items.filter((x) => x.kind === "event");
  for (let off = 0; off <= 7; off++) {
    const ds = addDaysStr(now.date, off);
    for (const ev of events) {
      if (!occursOn(ev, ds)) continue;
      if (ev.done && ev.done[ds]) continue;
      if (!ev.time) {
        // aviso el día elegido (el mismo día, 1 día antes...) a las 00:00, 09:00 y 18:00
        const rd = ev.remindDay;
        if (!(rd >= 0) || off !== rd) continue;
        const day = now.date; // hoy es el día del aviso
        const passed = o.slots.filter((h) => nowL >= asMs(day, h));
        if (!passed.length) continue;
        const slot = passed[passed.length - 1];
        const when = off === 0 ? "Hoy" : off === 1 ? "Mañana" : `El ${longDate(ds)}`;
        out.push({ key: `ev:${ev.id}:${ds}:${slot}`, title: ev.title || "Recordatorio", body: `${when} · ${ev.cat || "Personal"}`, tag: `ev:${ev.id}:${ds}:${slot}` });
      } else if (ev.remind >= 0) {
        const at = asMs(ds, ev.time);
        const fire = at - ev.remind * 60000;
        if (nowL >= fire && nowL <= at + 30 * 60000) {
          out.push({ key: `evt:${ev.id}:${ds}`, title: ev.title || "Recordatorio", body: `${off === 0 ? "Hoy" : "Mañana"} a las ${ev.time} · ${ev.cat || "Personal"}`, tag: `evt:${ev.id}:${ds}` });
        }
      }
    }
  }
  // presupuesto mensual
  const settings = items.find((x) => x.id === "settings" || x.kind === "settings") || {};
  const budget = Number(settings.budget) || 0;
  if (budget > 0) {
    const month = now.date.slice(0, 7);
    const spent = items.filter((x) => x.kind === "txn" && x.type !== "in" && String(x.date || "").startsWith(month)).reduce((a, x) => a + (Number(x.amount) || 0), 0);
    const r = spent / budget;
    if (r >= 1) {
      out.push({ key: `bud100:${month}`, extraKeys: [`bud80:${month}`], title: "Has superado tu presupuesto", body: `Llevas ${eur(spent)} gastados de ${eur(budget)} este mes (${Math.round(r * 100)} %).`, tag: `bud:${month}` });
    } else if (r >= 0.8) {
      out.push({ key: `bud80:${month}`, title: "Te acercas a tu límite de gastos", body: `Llevas ${eur(spent)} de ${eur(budget)} este mes (${Math.round(r * 100)} %). Te quedan ${eur(budget - spent)}.`, tag: `bud:${month}` });
    }
  }
  return out;
}



Deno.serve(async (req) => {
  // Se puede llamar sin clave: solo envía los avisos que ya tocan y nunca dos veces el mismo.
  if (!Deno.env.get("VAPID_PRIVATE_KEY")) return new Response("faltan las claves VAPID", { status: 500 });
  webpush.setVapidDetails(
    Deno.env.get("VAPID_SUBJECT") ?? "mailto:avisos@example.com",
    Deno.env.get("VAPID_PUBLIC_KEY")!,
    Deno.env.get("VAPID_PRIVATE_KEY")!,
  );
  let key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  if (!key) { try { const k = JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS") ?? "{}"); key = Object.values(k)[0] as string ?? ""; } catch (_) { /* sin clave */ } }
  const sb = createClient(Deno.env.get("SUPABASE_URL")!, key);
  const { data: subs, error } = await sb.from("push_subs").select("user_id,endpoint,p256dh,auth,tz");
  if (error) return new Response("subs: " + error.message, { status: 500 });

  const byUser = new Map<string, any[]>();
  for (const s of subs ?? []) { if (!byUser.has(s.user_id)) byUser.set(s.user_id, []); byUser.get(s.user_id)!.push(s); }

  let sent = 0, removed = 0;
  const now = Date.now();
  for (const [uid, userSubs] of byUser) {
    const { data: rows } = await sb.from("items").select("id,data").eq("user_id", uid).eq("deleted", false);
    const items = (rows ?? []).map((r: any) => ({ id: r.id, ...(r.data || {}) }));
    const tz = userSubs[0].tz || "Europe/Madrid";
    const due = computeDue(items, now, tz);
    if (!due.length) continue;
    const keys = due.flatMap((d: any) => [d.key, ...(d.extraKeys || [])]);
    const { data: logged } = await sb.from("push_log").select("key").eq("user_id", uid).in("key", keys);
    const done = new Set((logged ?? []).map((l: any) => l.key));
    for (const d of due) {
      if (done.has(d.key)) continue;
      const payload = JSON.stringify({ title: d.title, body: d.body, tag: d.tag, url: "./" });
      for (const s of userSubs) {
        try {
          await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload, { TTL: 6 * 3600 });
          sent++;
        } catch (e: any) {
          if (e && (e.statusCode === 404 || e.statusCode === 410)) {
            await sb.from("push_subs").delete().eq("endpoint", s.endpoint); removed++;
          } else console.error("push error", e?.statusCode, e?.body || e?.message);
        }
      }
      await sb.from("push_log").upsert([d.key, ...(d.extraKeys || [])].map((k) => ({ user_id: uid, key: k })), { onConflict: "user_id,key" });
    }
  }
  // limpieza del registro de avisos antiguos
  await sb.from("push_log").delete().lt("sent_at", new Date(now - 60 * 864e5).toISOString());
  return new Response(JSON.stringify({ sent, removed }), { headers: { "Content-Type": "application/json" } });
});
