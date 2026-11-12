/* Mi Día · sincronización en la nube (Supabase)
   - Los datos siguen guardándose en el dispositivo (funciona sin conexión).
   - Cada cambio se pone en una cola y se sube en cuanto hay sesión y conexión.
   - Al abrir la app, al volver a ella y cada minuto se descargan los cambios de otros dispositivos.
   - Conflictos: gana el cambio más reciente (marca _u en cada elemento). */
(function(){
"use strict";
const CFG=window.MIDIA_CONFIG||{};
const configured=!!(CFG.supabaseUrl&&CFG.supabaseKey);
const QKEY="midia-queue", PKEY="midia-lastpull", UKEY="midia-cloud-user";
const lsGet=(k,d)=>{try{const v=localStorage.getItem(k);return v==null?d:JSON.parse(v)}catch(e){return d}};
const lsSet=(k,v)=>{try{localStorage.setItem(k,JSON.stringify(v))}catch(e){}};
let queue=lsGet(QKEY,{});
let app=null, sb=null, session=null, syncing=false, lastSync=null, lastErr="", flushTimer=0, recovery=false;

/* ---------- interfaz: botón de cuenta y hoja ---------- */
const css=document.createElement("style");
css.textContent=`
.acct-btn{padding:8px 10px}
.acct-btn .dot{opacity:1;background:var(--muted)}
.acct-btn.ok .dot{background:var(--good)}
.acct-btn.warn .dot{background:var(--warn)}
.acct-btn.off .dot{background:var(--bad)}
.acct-row{display:flex;gap:10px;flex-wrap:wrap}
.acct-row .btn{flex:1;min-width:120px}
.acct-info{background:var(--bg);border:1px solid var(--line);border-radius:12px;padding:12px;display:flex;flex-direction:column;gap:4px;font-size:14px}
.acct-info b{overflow-wrap:anywhere}
.acct-note{font-size:13px;color:var(--muted)}
.acct-ok{color:var(--good);font-size:13px;font-weight:600;min-height:1em}
`;
document.head.appendChild(css);

const bar=document.querySelector(".topbar .bar-in");
const notif=document.getElementById("notifBtn");
const wrap=document.createElement("div"); wrap.className="row"; wrap.style.gap="8px";
const acctBtn=document.createElement("button");
acctBtn.type="button"; acctBtn.className="glass-btn acct-btn"; acctBtn.id="acctBtn";
acctBtn.innerHTML=`<span class="dot"></span><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="8" r="4"/><path d="M4 21c1.5-4 4.5-6 8-6s6.5 2 8 6"/></svg><span class="sr" style="position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)">Cuenta</span>`;
if(bar&&notif){notif.parentNode.insertBefore(wrap,notif);wrap.appendChild(acctBtn);wrap.appendChild(notif)}

const scrim=document.createElement("div");
scrim.className="scrim"; scrim.id="acctScrim"; scrim.setAttribute("aria-hidden","true");
scrim.innerHTML=`<div class="sheet" role="dialog" aria-modal="true" aria-labelledby="acctTitle">
  <div class="grab-zone"><div class="grab"></div>
    <div class="row between"><h2 id="acctTitle">Tu cuenta</h2><button type="button" class="icon-btn" data-close aria-label="Cerrar">×</button></div></div>
  <div id="acctBody" class="stack"></div>
</div>`;
const mainScript=document.currentScript;
(mainScript&&mainScript.parentNode?mainScript.parentNode:document.body).insertBefore(scrim,mainScript?mainScript.nextSibling:null);
const body=scrim.querySelector("#acctBody");
const esc=s=>String(s??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));

function ago(t){if(!t)return"todavía no";const s=Math.round((Date.now()-t)/1000);if(s<10)return"ahora mismo";if(s<60)return`hace ${s} s`;const m=Math.round(s/60);if(m<60)return`hace ${m} min`;return new Date(t).toLocaleString("es-ES",{day:"numeric",month:"short",hour:"2-digit",minute:"2-digit"})}
const pending=()=>Object.keys(queue).length;

function statusText(){
  if(!configured) return "Sincronización no configurada";
  if(!session) return "Sin cuenta · datos solo en este dispositivo";
  if(!navigator.onLine) return pending()?`Sin conexión · ${pending()} cambio${pending()>1?"s":""} pendiente${pending()>1?"s":""}`:"Sin conexión";
  if(syncing) return "Sincronizando…";
  if(lastErr) return "No se pudo sincronizar · se reintentará";
  if(pending()) return `${pending()} cambio${pending()>1?"s":""} por subir`;
  return `Guardado en la nube · ${ago(lastSync)}`;
}
function updBtn(){
  acctBtn.classList.remove("ok","warn","off");
  if(!configured||!session) acctBtn.classList.add("off");
  else if(lastErr||!navigator.onLine||pending()) acctBtn.classList.add("warn");
  else acctBtn.classList.add("ok");
  acctBtn.setAttribute("aria-label","Cuenta: "+statusText());
  acctBtn.title=statusText();
  const st=document.getElementById("acctStatus"); if(st) st.textContent=statusText();
}

let mode="login";
function render(){
  if(!configured){
    body.innerHTML=`<p class="acct-note">La sincronización en la nube aún no está configurada. Tus datos se guardan solo en este dispositivo.</p>`;
    return;
  }
  if(recovery){
    body.innerHTML=`<form class="stack" id="acctRec" novalidate>
      <p class="acct-note">Escribe tu nueva contraseña.</p>
      <label class="f" for="acctNew">Nueva contraseña<input id="acctNew" type="password" autocomplete="new-password" minlength="6"></label>
      <div class="err" id="acctErr"></div>
      <button class="btn primary" type="submit">Guardar contraseña</button></form>`;
    body.querySelector("#acctRec").onsubmit=async e=>{e.preventDefault();const p=body.querySelector("#acctNew").value;
      if(p.length<6){setErr("La contraseña debe tener al menos 6 caracteres.");return}
      const {error}=await sb.auth.updateUser({password:p}); if(error){setErr(trErr(error));return}
      recovery=false; app.toast("Contraseña cambiada","Ya puedes usarla en todos tus dispositivos."); render();};
    return;
  }
  if(session){
    const email=session.user&&session.user.email||"";
    body.innerHTML=`<div class="acct-info"><span class="acct-note">Has iniciado sesión como</span><b>${esc(email)}</b><span class="acct-note" id="acctStatus">${esc(statusText())}</span></div>
      <p class="acct-note">Tus datos se guardan en la nube y en este dispositivo. Entra con la misma cuenta en otro móvil u ordenador para verlos allí.</p>
      <div class="acct-row"><button class="btn" type="button" id="acctSync">Sincronizar ahora</button><button class="btn danger" type="button" id="acctOut">Cerrar sesión</button></div>
      <div class="acct-note" id="acctOutNote"></div>`;
    body.querySelector("#acctSync").onclick=()=>syncNow(true);
    let armed=false;
    body.querySelector("#acctOut").onclick=async function(){
      if(!armed){armed=true;this.textContent="Pulsa otra vez para salir";
        body.querySelector("#acctOutNote").textContent=pending()?`Ojo: hay ${pending()} cambio(s) sin subir que se perderán. Conéctate a internet y sincroniza antes de salir.`:"Al salir se borran los datos de este dispositivo. Seguirán guardados en tu cuenta.";
        setTimeout(()=>{armed=false;const b=body.querySelector("#acctOut");if(b)b.textContent="Cerrar sesión"},5000);return}
      await disablePush(); await sb.auth.signOut(); wipeLocal(); app.closeSheets(); app.toast("Sesión cerrada","Los datos siguen guardados en tu cuenta.");
    };
    return;
  }
  const isNew=mode==="signup";
  body.innerHTML=`<p class="acct-note">${isNew?"Crea tu cuenta para guardar tus datos en la nube y verlos en cualquier dispositivo.":"Inicia sesión para guardar tus datos en la nube y verlos en cualquier dispositivo."}</p>
    <div class="seg2" id="acctMode"><button type="button" data-m="login" aria-pressed="${!isNew}">Entrar</button><button type="button" data-m="signup" aria-pressed="${isNew}">Crear cuenta</button></div>
    <form class="stack" id="acctForm" novalidate>
      <label class="f" for="acctEmail">Correo electrónico<input id="acctEmail" type="email" inputmode="email" autocomplete="email" autocapitalize="off" spellcheck="false"></label>
      <label class="f" for="acctPass">Contraseña<input id="acctPass" type="password" autocomplete="${isNew?"new-password":"current-password"}"></label>
      <div class="err" id="acctErr"></div><div class="acct-ok" id="acctOk"></div>
      <button class="btn primary" type="submit" id="acctGo">${isNew?"Crear cuenta":"Entrar"}</button>
    </form>
    <div class="row between"><button class="btn link" type="button" id="acctForgot">He olvidado la contraseña</button><button class="btn link" type="button" data-close>Ahora no</button></div>`;
  body.querySelectorAll("#acctMode button").forEach(b=>b.onclick=()=>{mode=b.dataset.m;render()});
  body.querySelector("#acctForm").onsubmit=async e=>{
    e.preventDefault();
    const email=body.querySelector("#acctEmail").value.trim(), pass=body.querySelector("#acctPass").value;
    if(!/^\S+@\S+\.\S+$/.test(email)){setErr("Escribe un correo válido.");return}
    if(pass.length<6){setErr("La contraseña debe tener al menos 6 caracteres.");return}
    const go=body.querySelector("#acctGo"); go.disabled=true; go.textContent="Un momento…"; setErr("");
    try{
      const res=isNew?await sb.auth.signUp({email,password:pass}):await sb.auth.signInWithPassword({email,password:pass});
      if(res.error){setErr(trErr(res.error));return}
      if(isNew&&!res.data.session){setOk("Te hemos enviado un correo. Ábrelo para confirmar la cuenta y luego entra aquí.");return}
    }catch(err){setErr("No hay conexión. Inténtalo cuando tengas internet.")}
    finally{const g=body.querySelector("#acctGo");if(g){g.disabled=false;g.textContent=isNew?"Crear cuenta":"Entrar"}}
  };
  body.querySelector("#acctForgot").onclick=async()=>{
    const email=body.querySelector("#acctEmail").value.trim();
    if(!/^\S+@\S+\.\S+$/.test(email)){setErr("Escribe primero tu correo arriba.");return}
    const {error}=await sb.auth.resetPasswordForEmail(email,{redirectTo:location.origin+location.pathname});
    error?setErr(trErr(error)):setOk("Te hemos enviado un correo para cambiar la contraseña.");
  };
}
function setErr(t){const e=body.querySelector("#acctErr");if(e)e.textContent=t;const o=body.querySelector("#acctOk");if(o&&t)o.textContent=""}
function setOk(t){const e=body.querySelector("#acctOk");if(e)e.textContent=t;setErr("")}
function trErr(e){
  const m=String(e&&e.message||e||"").toLowerCase();
  if(m.includes("invalid login")) return "Correo o contraseña incorrectos.";
  if(m.includes("already registered")||m.includes("already been registered")) return "Ya existe una cuenta con ese correo. Pulsa «Entrar».";
  if(m.includes("email not confirmed")) return "Confirma tu correo con el enlace que te enviamos y vuelve a intentarlo.";
  if(m.includes("password")&&m.includes("least")) return "La contraseña es demasiado corta.";
  if(m.includes("rate limit")||m.includes("too many")) return "Demasiados intentos. Espera un minuto.";
  if(m.includes("fetch")||m.includes("network")) return "No hay conexión. Inténtalo cuando tengas internet.";
  return "No se pudo completar: "+(e&&e.message||"error desconocido");
}
acctBtn.addEventListener("click",()=>{render();app&&app.openSheet("#acctScrim")});

/* ---------- datos locales ---------- */
function wipeLocal(){
  queue={}; lsSet(QKEY,queue); lsSet(PKEY,null); lsSet(UKEY,null);
  app.applyRemote([...app.items().keys()].map(id=>({id,data:null})));
}

/* ---------- cola y sincronización ---------- */
function enqueue(id,obj){
  queue[id]={d:obj||null,u:(obj&&obj._u)||Date.now()};
  lsSet(QKEY,queue); updBtn();
  clearTimeout(flushTimer); flushTimer=setTimeout(()=>syncNow(false),900);
}
async function push(){
  const ids=Object.keys(queue); if(!ids.length) return;
  const uid=session.user.id;
  for(let i=0;i<ids.length;i+=200){
    const chunk=ids.slice(i,i+200).map(id=>[id,queue[id]]);
    const rows=chunk.map(([id,q])=>({user_id:uid,id,data:q.d?q.d:{_u:q.u},deleted:!q.d}));
    const {error}=await sb.from("items").upsert(rows,{onConflict:"user_id,id"});
    if(error) throw error;
    chunk.forEach(([id,q])=>{if(queue[id]&&queue[id].u===q.u&&queue[id].d===q.d)delete queue[id]});
    lsSet(QKEY,queue);
  }
}
async function pull(){
  let last=lsGet(PKEY,null);
  for(let guard=0;guard<50;guard++){
    let q=sb.from("items").select("id,data,deleted,updated_at");
    if(last) q=q.gte("updated_at",last);
    const {data,error}=await q.order("updated_at",{ascending:true}).limit(1000);
    if(error) throw error;
    const changes=[], items=app.items();
    for(const r of data||[]){
      const ru=(r.data&&r.data._u)||0;
      const pend=queue[r.id]; if(pend&&pend.u>ru) continue;
      const loc=items.get(r.id), lu=(loc&&loc._u)||0;
      if(r.deleted){ if(loc&&ru>=lu) changes.push({id:r.id,data:null}); }
      else if(!loc||ru>=lu){ if(JSON.stringify(loc)!==JSON.stringify(r.data)) changes.push({id:r.id,data:r.data}); }
      if(!last||r.updated_at>last) last=r.updated_at;
    }
    if(changes.length) app.applyRemote(changes);
    lsSet(PKEY,last);
    if(!data||data.length<1000) break;
  }
}
async function syncNow(manual){
  if(!sb||!session||syncing) {updBtn();return}
  if(!navigator.onLine){updBtn();if(manual)app.toast("Sin conexión","Los cambios se subirán en cuanto tengas internet.");return}
  syncing=true; updBtn();
  try{await push();await pull();lastSync=Date.now();lastErr="";if(manual)app.toast("Sincronizado","Tus datos están al día en la nube.")}
  catch(e){lastErr=String(e&&e.message||e);if(manual)app.toast("No se pudo sincronizar","Revisa tu conexión e inténtalo de nuevo.")}
  finally{syncing=false;updBtn()}
}
function onSession(s,first){
  const prevUser=lsGet(UKEY,null);
  session=s;
  if(s){
    if(prevUser!==s.user.id){
      // primera vez con esta cuenta en este dispositivo: subir lo que ya hubiera y descargar todo
      lsSet(UKEY,s.user.id); lsSet(PKEY,null);
      app.items().forEach((v,k)=>{if(!queue[k])queue[k]={d:v,u:(v&&v._u)||Date.now()}});
      lsSet(QKEY,queue);
      if(!first) app.toast("Sesión iniciada","Tus datos se están guardando en la nube.");
    }
    if(scrim.classList.contains("on")&&!recovery) app.closeSheets();
    syncNow(false); refreshPush();
  }
  updBtn(); if(scrim.classList.contains("on")) render();
}

/* ---------- notificaciones push (llegan con la app cerrada) ---------- */
const isStandalone=()=>{try{return window.matchMedia("(display-mode: standalone)").matches||navigator.standalone===true}catch(e){return false}};
const isIOS=()=>/iPad|iPhone|iPod/.test(navigator.userAgent)||(navigator.platform==="MacIntel"&&navigator.maxTouchPoints>1);
const pushCapable=()=>"serviceWorker" in navigator&&"PushManager" in window&&"Notification" in window;
function b64ToBytes(b){const p="=".repeat((4-b.length%4)%4);const s=atob((b+p).replace(/-/g,"+").replace(/_/g,"/"));return Uint8Array.from(s,c=>c.charCodeAt(0))}
async function saveSub(sub){
  const j=sub.toJSON();
  const tz=(Intl.DateTimeFormat().resolvedOptions().timeZone)||"Europe/Madrid";
  const {error}=await sb.from("push_subs").upsert({user_id:session.user.id,endpoint:j.endpoint,p256dh:j.keys.p256dh,auth:j.keys.auth,tz,ua:navigator.userAgent.slice(0,200)},{onConflict:"endpoint"});
  if(error) throw error;
}
const swReady=(ms)=>Promise.race([navigator.serviceWorker.ready,new Promise((_,rej)=>setTimeout(()=>rej(new Error("La app aún se está preparando. Ciérrala, vuelve a abrirla y pulsa otra vez.")),ms||4000))]);
async function currentSub(){try{if(!("serviceWorker" in navigator))return null;const reg=await navigator.serviceWorker.getRegistration();return reg&&reg.pushManager?await reg.pushManager.getSubscription():null}catch(e){return null}}
async function enablePush(){
  if(!configured) return {ok:false,msg:"La nube aún no está configurada."};
  if(!pushCapable()) return {ok:false,msg:isIOS()&&!isStandalone()?"Abre Mi Día desde el icono de tu pantalla de inicio y pulsa aquí otra vez.":"Este navegador no admite notificaciones push."};
  if(isIOS()&&!isStandalone()) return {ok:false,msg:"Abre Mi Día desde el icono de tu pantalla de inicio y pulsa aquí otra vez."};
  if(!session) return {ok:false,msg:"Inicia sesión primero (botón de la persona, arriba).",login:true};
  if(!CFG.vapidPublicKey) return {ok:false,msg:"Falta la clave de notificaciones."};
  let perm=Notification.permission;
  if(perm==="default") perm=await Notification.requestPermission();
  if(perm!=="granted") return {ok:false,msg:"Has bloqueado las notificaciones. Actívalas en Ajustes → Notificaciones → Mi Día."};
  const reg=await swReady(6000);
  let sub=await reg.pushManager.getSubscription();
  if(!sub) sub=await reg.pushManager.subscribe({userVisibleOnly:true,applicationServerKey:b64ToBytes(CFG.vapidPublicKey)});
  await saveSub(sub);
  try{localStorage.setItem("midia-push","1")}catch(e){}
  return {ok:true,msg:"Te llegarán los recordatorios a las 9:00 y los avisos de presupuesto aunque la app esté cerrada."};
}
async function refreshPush(){ // vuelve a guardar la suscripción por si cambió
  if(!session||!pushCapable()||Notification.permission!=="granted") return;
  const sub=await currentSub(); if(sub){try{await saveSub(sub)}catch(e){}}
}
async function disablePush(){
  const sub=await currentSub(); if(!sub) return;
  try{await sb.from("push_subs").delete().eq("endpoint",sub.endpoint)}catch(e){}
  try{await sub.unsubscribe()}catch(e){}
  try{localStorage.removeItem("midia-push")}catch(e){}
}

/* ---------- enlace personal para Apple Pay (Atajos) ---------- */
function randToken(){const b=new Uint8Array(24);crypto.getRandomValues(b);return btoa(String.fromCharCode(...b)).replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/,"")}
async function getIngestUrl(regen){
  if(!configured) return {ok:false,msg:"La nube no está configurada."};
  if(!session) return {ok:false,msg:"Inicia sesión primero (botón de la persona, arriba).",login:true};
  let token=null;
  if(!regen){const {data,error}=await sb.from("ingest_tokens").select("token").eq("user_id",session.user.id).maybeSingle();if(error)return {ok:false,msg:"No se pudo leer tu enlace. Revisa tu conexión."};token=data&&data.token}
  if(!token){token=randToken();const {error}=await sb.from("ingest_tokens").upsert({user_id:session.user.id,token},{onConflict:"user_id"});if(error)return {ok:false,msg:"No se pudo crear tu enlace. Revisa tu conexión."}}
  return {ok:true,url:`${CFG.supabaseUrl}/functions/v1/gasto?t=${token}`,auth:"Bearer "+CFG.supabaseKey};
}
async function sendTestExpense(url){
  try{const r=await fetch(url,{method:"POST",headers:{"Content-Type":"application/json","Authorization":"Bearer "+CFG.supabaseKey,"apikey":CFG.supabaseKey},body:JSON.stringify({importe:"0,01 €",comercio:"Prueba Apple Pay"})});const t=await r.text();setTimeout(()=>syncNow(false),800);return {ok:r.ok,msg:t}}
  catch(e){return {ok:false,msg:"No hay conexión con el servidor."}}
}

/* ---------- arranque (lo llama la app) ---------- */
window.MidiaCloud={
  queue:(id,obj)=>{if(configured)enqueue(id,obj)},
  pushReady:()=>configured,
  enablePush:()=>enablePush().catch(e=>({ok:false,msg:"No se pudieron activar: "+(e&&e.message||e)})),
  pushActive:()=>{try{return localStorage.getItem("midia-push")==="1"&&Notification.permission==="granted"}catch(e){return false}},
  openAccount:()=>{render();app.openSheet("#acctScrim")},
  hasSession:()=>!!session,
  getIngestUrl:(regen)=>getIngestUrl(regen).catch(()=>({ok:false,msg:"No se pudo obtener tu enlace."})),
  sendTestExpense:(u)=>sendTestExpense(u),
  start(a){
    app=a; updBtn();
    if(!configured) return;
    if(!window.supabase||!window.supabase.createClient){lastErr="sin librería";updBtn();return}
    try{sb=window.supabase.createClient(CFG.supabaseUrl,CFG.supabaseKey,{auth:{persistSession:true,autoRefreshToken:true,detectSessionInUrl:true}})}
    catch(e){lastErr=String(e);updBtn();return}
    sb.auth.onAuthStateChange((ev,s)=>{
      if(ev==="PASSWORD_RECOVERY"){recovery=true;session=s;render();app.openSheet("#acctScrim");return}
      if(ev==="INITIAL_SESSION") return;
      onSession(s,false);
    });
    sb.auth.getSession().then(({data})=>{
      const s=data&&data.session;
      onSession(s,true);
      if(!s&&!sessionStorage.getItem("midia-asked")){setTimeout(function ask(){if(document.getElementById("splash")){setTimeout(ask,500);return}if(!session&&!document.querySelector(".scrim.on")&&!sessionStorage.getItem("midia-asked")){try{sessionStorage.setItem("midia-asked","1")}catch(e){}render();app.openSheet("#acctScrim")}},700)}
    }).catch(()=>updBtn());
    document.addEventListener("visibilitychange",()=>{if(!document.hidden)syncNow(false)});
    window.addEventListener("online",()=>syncNow(false));
    window.addEventListener("offline",updBtn);
    setInterval(()=>{if(!document.hidden)syncNow(false);else updBtn()},60000);
  }
};
})();
