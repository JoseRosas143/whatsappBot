/* eslint-disable no-console */
const { createClient } = require("@supabase/supabase-js");
const supabase = createClient(process.env.SUPABASE_URL || "", process.env.SUPABASE_KEY || "");

function startOfToday(){ const d=new Date(); d.setHours(0,0,0,0); return d; }
function startOfTomorrow(){ const d=startOfToday(); d.setDate(d.getDate()+1); return d; }
function startOfWeekMonday(){ const d=startOfToday(); const day=d.getDay(); const diff=(day===0?-6:1-day); d.setDate(d.getDate()+diff); return d; }
function startOfNextWeekMonday(){ const d=startOfWeekMonday(); d.setDate(d.getDate()+7); return d; }
function startOfMonth(){ const d=startOfToday(); d.setDate(1); return d; }
function startOfNextMonth(){ const d=startOfMonth(); d.setMonth(d.getMonth()+1); return d; }
const money=(n)=>`$${Number(n||0).toFixed(2)}`;

async function fetchOrdersBetween(a,b){
  const {data,error}=await supabase.from("ordenes").select("id,cliente_telefono,total,fecha_creacion").gte("fecha_creacion",a).lt("fecha_creacion",b);
  if(error) throw new Error(error.message);
  return data||[];
}
async function fetchDetalleBetween(a,b){
  const {data,error}=await supabase.from("detalle_orden").select("producto_nombre,cantidad,fecha_creacion").gte("fecha_creacion",a).lt("fecha_creacion",b);
  if(error) throw new Error(error.message);
  return data||[];
}

async function setConfig(key, value){
  const { error } = await supabase.from("app_config").upsert({ key, value, updated_at: new Date().toISOString() }, { onConflict: "key" });
  if (error) throw new Error(error.message);
}
async function getConfig(key){
  const { data, error } = await supabase.from("app_config").select("value").eq("key", key).maybeSingle();
  if (error) throw new Error(error.message);
  return data?.value ?? null;
}

async function setPromo(dow, text){
  const d = Number(dow);
  if (!Number.isInteger(d) || d < 0 || d > 6) return { ok:false, error:"DOW_INVALIDO" };
  const { error } = await supabase.from("promos").upsert({ dow: d, text: String(text || "").trim(), updated_at: new Date().toISOString() }, { onConflict: "dow" });
  if (error) throw new Error(error.message);
  return { ok:true };
}
async function listPromos(){
  const { data, error } = await supabase.from("promos").select("dow,text").order("dow",{ascending:true});
  if (error) throw new Error(error.message);
  return data||[];
}

async function listFaqs(){
  const { data, error } = await supabase.from("faqs").select("id,title,orden").order("orden",{ascending:true});
  if (error) throw new Error(error.message);
  return data||[];
}
async function setFaq(id, title, body, orden=null){
  const payload = {
    id: String(id||"").trim(),
    title: String(title||"").trim(),
    body: String(body||"").trim(),
    updated_at: new Date().toISOString()
  };
  if (!payload.id || !payload.title || !payload.body) return { ok:false, error:"FALTAN_DATOS" };
  if (orden !== null && orden !== undefined) payload.orden = Number(orden)||0;
  const { error } = await supabase.from("faqs").upsert(payload, { onConflict: "id" });
  if (error) throw new Error(error.message);
  return { ok:true };
}

// Menu admin determinista
async function setDisponibilidad(producto, disponible) {
  const nombre = String(producto||"").trim();
  if (!nombre) return { ok:false, error:"FALTA_PRODUCTO" };
  const { data, error } = await supabase.from("menu").update({ disponible }).eq("nombre", nombre).select("nombre,disponible").maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) return { ok:false, error:"NO_ENCONTRADO" };
  return { ok:true, data };
}

async function cambiarPrecio(producto, precio) {
  const nombre = String(producto||"").trim();
  const p = Number(precio);
  if (!nombre || !Number.isFinite(p) || p <= 0) return { ok:false, error:"DATOS_INVALIDOS" };
  const { data, error } = await supabase.from("menu").update({ precio: p }).eq("nombre", nombre).select("nombre,precio").maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) return { ok:false, error:"NO_ENCONTRADO" };
  return { ok:true, data };
}

async function agregarProducto(nombre, precio, categoria) {
  const n = String(nombre||"").trim();
  const p = Number(precio);
  const c = categoria ? String(categoria).trim() : null;
  if (!n || !Number.isFinite(p) || p <= 0) return { ok:false, error:"DATOS_INVALIDOS" };

  const { error } = await supabase.from("menu").insert({ nombre: n, precio: p, categoria: c, disponible: true });
  if (error) throw new Error(error.message);
  return { ok:true };
}

async function handleAdminText(text){
  const t = String(text||"").trim();

  // KPIs
  if (/^ventas\s+hoy$/i.test(t)){
    const a=startOfToday().toISOString(), b=startOfTomorrow().toISOString();
    const orders=await fetchOrdersBetween(a,b);
    const total=orders.reduce((s,o)=>s+Number(o.total||0),0);
    return `📊 Ventas HOY\nÓrdenes: ${orders.length}\nTotal: ${money(total)}`;
  }
  if (/^ventas\s+semana$/i.test(t)){
    const a=startOfWeekMonday().toISOString(), b=startOfNextWeekMonday().toISOString();
    const orders=await fetchOrdersBetween(a,b);
    const total=orders.reduce((s,o)=>s+Number(o.total||0),0);
    return `📊 Ventas SEMANA\nÓrdenes: ${orders.length}\nTotal: ${money(total)}`;
  }
  if (/^ventas\s+mes$/i.test(t)){
    const a=startOfMonth().toISOString(), b=startOfNextMonth().toISOString();
    const orders=await fetchOrdersBetween(a,b);
    const total=orders.reduce((s,o)=>s+Number(o.total||0),0);
    return `📊 Ventas MES\nÓrdenes: ${orders.length}\nTotal: ${money(total)}`;
  }
  if (/^clientes\s+hoy$/i.test(t)){
    const a=startOfToday().toISOString(), b=startOfTomorrow().toISOString();
    const orders=await fetchOrdersBetween(a,b);
    const set=new Set(orders.map(o=>o.cliente_telefono).filter(Boolean));
    return `👥 Clientes HOY (distinct)\nTotal: ${set.size}`;
  }
  if (/^ticket\s+promedio\s+hoy$/i.test(t)){
    const a=startOfToday().toISOString(), b=startOfTomorrow().toISOString();
    const orders=await fetchOrdersBetween(a,b);
    if(!orders.length) return `🧾 Ticket promedio HOY\nÓrdenes: 0\nPromedio: $0.00`;
    const total=orders.reduce((s,o)=>s+Number(o.total||0),0);
    return `🧾 Ticket promedio HOY\nÓrdenes: ${orders.length}\nPromedio: ${money(total/orders.length)}`;
  }
  if (/^producto\s+m[aá]s\s+vendido\s+hoy$/i.test(t)){
    const a=startOfToday().toISOString(), b=startOfTomorrow().toISOString();
    const rows=await fetchDetalleBetween(a,b);
    const map=new Map();
    for(const r of rows) map.set(r.producto_nombre,(map.get(r.producto_nombre)||0)+Number(r.cantidad||0));
    let best=null;
    for(const [p,qty] of map.entries()) if(!best||qty>best.qty) best={producto:p,qty};
    return best ? `🏆 Más vendido HOY\n${best.producto} — ${best.qty} uds` : "No hay ventas de productos hoy.";
  }
  if (/^producto\s+menos\s+vendido\s+hoy$/i.test(t)){
    const a=startOfToday().toISOString(), b=startOfTomorrow().toISOString();
    const rows=await fetchDetalleBetween(a,b);
    const map=new Map();
    for(const r of rows) map.set(r.producto_nombre,(map.get(r.producto_nombre)||0)+Number(r.cantidad||0));
    let worst=null;
    for(const [p,qty] of map.entries()) if(!worst||qty<worst.qty) worst={producto:p,qty};
    return worst ? `🐢 Menos vendido HOY\n${worst.producto} — ${worst.qty} uds` : "No hay ventas de productos hoy.";
  }

  // Menu ops
  {
    const m = t.match(/^(.+)\s+agotado$/i);
    if (m) {
      const r = await setDisponibilidad(m[1], false);
      if (!r.ok) return "❌ Producto no encontrado o nombre inválido.";
      return `✅ Marcado agotado: ${r.data.nombre}`;
    }
  }
  {
    const m = t.match(/^(.+)\s+disponible$/i);
    if (m) {
      const r = await setDisponibilidad(m[1], true);
      if (!r.ok) return "❌ Producto no encontrado o nombre inválido.";
      return `✅ Marcado disponible: ${r.data.nombre}`;
    }
  }
  {
    const m = t.match(/^cambiar\s+precio\s+(.+)\s+a\s+(\d+(\.\d{1,2})?)$/i);
    if (m) {
      const r = await cambiarPrecio(m[1], m[2]);
      if (!r.ok) return "❌ Formato: Cambiar precio <Producto> a <Precio>";
      return `✅ Precio actualizado: ${r.data.nombre} = $${Number(r.data.precio).toFixed(2)}`;
    }
  }
  {
    const m = t.match(/^agregar\s+producto\s+(.+)\s+(\d+(\.\d{1,2})?)\s+(.+)$/i);
    if (m) {
      const r = await agregarProducto(m[1], m[2], m[4]);
      if (!r.ok) return "❌ Formato: Agregar producto <Nombre> <Precio> <Categoria>";
      return `✅ Producto agregado: ${m[1]} ($${Number(m[2]).toFixed(2)}) / ${m[4]}`;
    }
  }

  // Links
  {
    const m = t.match(/^set\s+link\s+([a-z0-9_]+)\s+(https?:\/\/\S+)$/i);
    if (m) { await setConfig(m[1], m[2]); return `✅ Link actualizado: ${m[1]} = ${m[2]}`; }
  }
  if (/^ver\s+links$/i.test(t)) {
    const keys = ["menu_visual_url","payment_link","google_review_url","privacy_url","terms_url"];
    const pairs = [];
    for (const k of keys) pairs.push(`${k}: ${await getConfig(k)}`);
    return "🔗 Links actuales:\n" + pairs.join("\n");
  }

  // Promos
  {
    const m = t.match(/^promo\s+set\s+(\d)\s*\|\s*(.+)$/i);
    if (m) {
      const r = await setPromo(m[1], m[2]);
      if (!r.ok) return "❌ DOW inválido (0=Dom..6=Sab).";
      return `✅ Promo actualizada para dow=${m[1]}`;
    }
  }
  if (/^promo\s+list$/i.test(t)) {
    const rows = await listPromos();
    return "📅 Promos:\n" + rows.map(r => `${r.dow}: ${r.text}`).join("\n");
  }

  // FAQs
  if (/^faq\s+list$/i.test(t)) {
    const rows = await listFaqs();
    return "❓ FAQs:\n" + rows.map(r => `${r.id} — ${r.title} (orden ${r.orden})`).join("\n");
  }
  {
    const m = t.match(/^faq\s+set\s+([a-z0-9_]+)\s*\|\s*(.+?)\s*\|\s*(.+?)(\s*\|\s*(\d+))?$/i);
    if (m) {
      const id = m[1], title = m[2], body = m[3], ord = m[5] ?? null;
      const r = await setFaq(id, title, body, ord);
      if (!r.ok) return "❌ Formato: faq set <id> | <titulo> | <cuerpo> | <orden(opcional)>";
      return `✅ FAQ actualizada: ${id}`;
    }
  }

  // Chat humano: comando para que el bot envíe al cliente (tu WhatsApp admin escribe esto)
  {
    const m = t.match(/^enviar\s+a\s+(\d{10,15})\s*:\s*(.+)$/i);
    if (m) return JSON.stringify({ __action: "SEND_TO_CLIENT", to: m[1], text: m[2] });
  }

  if (/^(admin\s+help|ayuda\s+admin|help)$/i.test(t)) {
    return (
      "🛠️ Admin comandos:\n" +
      "KPIs: Ventas hoy | Ventas semana | Ventas mes | Clientes hoy | Ticket promedio hoy | Producto más vendido hoy | Producto menos vendido hoy\n\n" +
      "Menú:\n" +
      "• <Producto> agotado\n• <Producto> disponible\n• Cambiar precio <Producto> a <Precio>\n• Agregar producto <Nombre> <Precio> <Categoria>\n\n" +
      "Links:\n" +
      "• Ver links\n• Set link <key> <url>\n(keys: menu_visual_url, payment_link, google_review_url, privacy_url, terms_url)\n\n" +
      "Promos:\n• Promo list\n• Promo set <0-6> | <texto>\n\n" +
      "FAQs:\n• FAQ list\n• FAQ set <id> | <titulo> | <cuerpo> | <orden(opcional)>\n\n" +
      "Chat humano:\n• Enviar a <telefono>: <mensaje>"
    );
  }

  return "Comando admin no reconocido. Escribe: Admin help";
}

module.exports = { handleAdminText };
