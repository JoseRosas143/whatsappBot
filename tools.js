/* eslint-disable no-console */
require("dotenv").config({ path: require("path").join(__dirname, ".env") });
if (!process.env.SUPABASE_URL) {
  console.error("❌ SUPABASE_URL no está cargando. Revisa .env en:", require("path").join(__dirname, ".env"));
  process.exit(1);
}
const { createClient } = require("@supabase/supabase-js");

const supabase = createClient(process.env.SUPABASE_URL || "", process.env.SUPABASE_KEY || "");

const ADMIN_PHONE = process.env.ADMIN_PHONE || "";
const KDS_PHONE = process.env.KDS_PHONE || "";

function assertNonEmpty(v, name) {
  if (!v || typeof v !== "string" || !v.trim()) throw new Error(`Falta o inválido: ${name}`);
}
function normalizePhone(t) { return String(t || "").trim(); }
function normalizeName(s) { const x = String(s || "").trim(); return x ? x : null; }
function parseMesa(v) {
  if (v === undefined || v === null) return null;
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw new Error("numero_mesa inválido");
  return n;
}
function parsePositiveInt(n, field) {
  const x = Number(n);
  if (!Number.isInteger(x) || x <= 0) throw new Error(`${field} inválido`);
  return x;
}
function isValidEmail(email) {
  const s = String(email || "").trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
}
function isValidRFC(rfc) {
  const s = String(rfc || "").trim().toUpperCase();
  return /^[A-Z&Ñ]{3,4}\d{6}[A-Z0-9]{3}$/.test(s);
}
function isValidISODate(dateStr) {
  const s = String(dateStr || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime());
}
function formatMoney(n) { return Number(n || 0).toFixed(2); }
function nowHHMM() {
  const d = new Date();
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}
function sameDay(a, b) {
  const da = new Date(a), db = new Date(b);
  return da.getFullYear() === db.getFullYear() && da.getMonth() === db.getMonth() && da.getDate() === db.getDate();
}

async function get_config(key, fallback = null) {
  const { data, error } = await supabase.from("app_config").select("value").eq("key", key).maybeSingle();
  if (error) throw new Error(error.message);
  return data?.value ?? fallback;
}

async function getCliente(telefono) {
  const { data, error } = await supabase.from("clientes").select("*").eq("telefono", telefono).maybeSingle();
  if (error) throw new Error(error.message);
  return data || null;
}

async function identificar_cliente(telefono, nombre_opcional) {
  telefono = normalizePhone(telefono);
  assertNonEmpty(telefono, "telefono");
  const nombre = normalizeName(nombre_opcional);

  const existing = await getCliente(telefono);
  if (!existing) {
    const { data, error } = await supabase
      .from("clientes")
      .insert({ telefono, nombre: nombre || null, ultimo_mensaje: new Date().toISOString() })
      .select("*")
      .maybeSingle();
    if (error) throw new Error(error.message);
    return { ok: true, cliente: data, created: true };
  }

  const patch = { ultimo_mensaje: new Date().toISOString() };
  if (nombre && (!existing.nombre || !String(existing.nombre).trim())) patch.nombre = nombre;

  const { data, error } = await supabase.from("clientes").update(patch).eq("telefono", telefono).select("*").maybeSingle();
  if (error) throw new Error(error.message);
  return { ok: true, cliente: data, created: false };
}

async function bumpVisitasIfNewDay(telefono) {
  const cliente = await getCliente(telefono);
  if (!cliente) return null;

  const now = new Date();
  const last = cliente.ultimo_mensaje ? new Date(cliente.ultimo_mensaje) : null;
  const shouldInc = !last || !sameDay(last, now);

  const patch = { ultimo_mensaje: now.toISOString() };
  if (shouldInc) patch.visitas = Number(cliente.visitas || 0) + 1;

  const { data, error } = await supabase.from("clientes").update(patch).eq("telefono", telefono).select("*").maybeSingle();
  if (error) throw new Error(error.message);
  return data || null;
}

async function consultar_menu(categoria_opcional) {
  let q = supabase
    .from("menu")
    .select("id,nombre,descripcion,precio,categoria,disponible")
    .eq("disponible", true)
    .order("categoria", { ascending: true })
    .order("nombre", { ascending: true });

  if (categoria_opcional && String(categoria_opcional).trim()) q = q.eq("categoria", String(categoria_opcional).trim());

  const { data, error } = await q;
  if (error) throw new Error(error.message);
  return { ok: true, items: data || [] };
}

async function getLatestOrderByPhone(telefono, allowedStates = ["abierta", "pendiente_pago"]) {
  const { data, error } = await supabase
    .from("ordenes")
    .select("*")
    .eq("cliente_telefono", telefono)
    .in("estado", allowedStates)
    .order("fecha_creacion", { ascending: false })
    .limit(1);
  if (error) throw new Error(error.message);
  return data?.[0] || null;
}

async function asegurar_orden_abierta(telefono, numero_mesa_opcional) {
  telefono = normalizePhone(telefono);
  assertNonEmpty(telefono, "telefono");
  const mesa = parseMesa(numero_mesa_opcional);

  await identificar_cliente(telefono, null);

  let orden = await getLatestOrderByPhone(telefono, ["abierta", "pendiente_pago"]);
  if (!orden) {
    const { data, error } = await supabase
      .from("ordenes")
      .insert({ cliente_telefono: telefono, numero_mesa: mesa, estado: "abierta", total: 0.0 })
      .select("*")
      .maybeSingle();
    if (error) throw new Error(error.message);
    return { ok: true, orden: data, created: true };
  }

  if (mesa && (!orden.numero_mesa || Number(orden.numero_mesa) !== mesa)) {
    const { data, error } = await supabase.from("ordenes").update({ numero_mesa: mesa }).eq("id", orden.id).select("*").maybeSingle();
    if (error) throw new Error(error.message);
    orden = data;
  }

  return { ok: true, orden, created: false };
}

async function recalcAndUpdateOrderTotal(ordenId) {
  const { data, error } = await supabase.from("detalle_orden").select("subtotal").eq("orden_id", ordenId);
  if (error) throw new Error(error.message);

  const total = (data || []).reduce((sum, r) => sum + Number(r.subtotal || 0), 0);
  const { error: updErr } = await supabase.from("ordenes").update({ total }).eq("id", ordenId);
  if (updErr) throw new Error(updErr.message);
  return total;
}

async function previsualizar_pedido(telefono, numero_mesa, items) {
  telefono = normalizePhone(telefono);
  assertNonEmpty(telefono, "telefono");

  const mesa = parseMesa(numero_mesa);
  if (!Array.isArray(items) || items.length === 0) throw new Error("items[] requerido");

  const { orden } = await asegurar_orden_abierta(telefono, mesa);
  if (!orden.numero_mesa) throw new Error("La orden debe tener numero_mesa antes de previsualizar.");

  const normalized = items.map((it, idx) => {
    const producto_nombre = String(it.producto_nombre || it.producto || "").trim();
    if (!producto_nombre) throw new Error(`Item #${idx + 1}: producto_nombre requerido`);
    const cantidad = parsePositiveInt(it.cantidad ?? 1, `Item #${idx + 1}: cantidad`);
    const notas = it.notas ? String(it.notas).trim() : null;
    const consumidor = it.consumidor ? String(it.consumidor).trim() : "General";
    return { producto_nombre, cantidad, notas, consumidor };
  });

  const { data: menuAll, error: menuAllErr } = await supabase
    .from("menu")
    .select("nombre,precio,disponible,categoria")
    .eq("disponible", true);
  if (menuAllErr) throw new Error(menuAllErr.message);

  const menuMapExact = new Map((menuAll || []).map((m) => [m.nombre, m]));
  const menuMapLower = new Map((menuAll || []).map((m) => [String(m.nombre).toLowerCase(), m.nombre]));

  for (const it of normalized) {
    if (!menuMapExact.has(it.producto_nombre)) {
      const fixed = menuMapLower.get(String(it.producto_nombre).toLowerCase());
      if (fixed) it.producto_nombre = fixed;
    }
  }

  const nombres = [...new Set(normalized.map((x) => x.producto_nombre))];
  const missing = nombres.filter((n) => !menuMapExact.has(n));
  if (missing.length) {
    const alternativas = (menuAll || []).slice(0, 8).map((m) => ({ nombre: m.nombre, categoria: m.categoria, precio: m.precio }));
    return { ok: false, error: "PRODUCTOS_NO_DISPONIBLES", missing, alternativas };
  }

  const rowsToInsert = normalized.map((it) => {
    const m = menuMapExact.get(it.producto_nombre);
    const precio_unitario = Number(m.precio);
    const subtotal = precio_unitario * it.cantidad;
    return {
      orden_id: orden.id,
      producto_nombre: it.producto_nombre,
      cantidad: it.cantidad,
      precio_unitario,
      subtotal,
      notas: it.notas,
      consumidor: it.consumidor,
      enviado_cocina: false
    };
  });

  const { error: insErr } = await supabase.from("detalle_orden").insert(rowsToInsert);
  if (insErr) throw new Error(insErr.message);

  const { data: pendientes, error: pendErr } = await supabase
    .from("detalle_orden")
    .select("id,producto_nombre,cantidad,precio_unitario,subtotal,notas,consumidor,enviado_cocina,fecha_creacion")
    .eq("orden_id", orden.id)
    .eq("enviado_cocina", false)
    .order("fecha_creacion", { ascending: true });
  if (pendErr) throw new Error(pendErr.message);

  const totalPendiente = (pendientes || []).reduce((sum, r) => sum + Number(r.subtotal || 0), 0);
  const total = await recalcAndUpdateOrderTotal(orden.id);

  return { ok: true, orden_id: orden.id, numero_mesa: orden.numero_mesa, pendientes: pendientes || [], total_pendiente: totalPendiente, total_orden: total };
}

async function cancelar_item_sin_enviar(telefono, producto, consumidor_opcional) {
  telefono = normalizePhone(telefono);
  assertNonEmpty(telefono, "telefono");
  const prod = String(producto || "").trim();
  assertNonEmpty(prod, "producto");

  const consumidor = consumidor_opcional ? String(consumidor_opcional).trim() : null;

  const orden = await getLatestOrderByPhone(telefono, ["abierta", "pendiente_pago"]);
  if (!orden) return { ok: false, error: "NO_HAY_ORDEN" };

  let q = supabase
    .from("detalle_orden")
    .select("id,producto_nombre,consumidor,enviado_cocina,fecha_creacion")
    .eq("orden_id", orden.id)
    .eq("enviado_cocina", false)
    .eq("producto_nombre", prod)
    .order("fecha_creacion", { ascending: false })
    .limit(1);

  if (consumidor) q = q.eq("consumidor", consumidor);

  const { data, error } = await q;
  if (error) throw new Error(error.message);

  const row = data?.[0];
  if (!row) return { ok: false, error: "NO_EXISTE_ITEM_PENDIENTE" };

  const { error: delErr } = await supabase.from("detalle_orden").delete().eq("id", row.id);
  if (delErr) throw new Error(delErr.message);

  await recalcAndUpdateOrderTotal(orden.id);
  return { ok: true, deleted_id: row.id, producto: row.producto_nombre };
}

async function confirmar_comanda_cocina(telefono) {
  telefono = normalizePhone(telefono);
  assertNonEmpty(telefono, "telefono");

  const cliente = await getCliente(telefono);
  const orden = await getLatestOrderByPhone(telefono, ["abierta", "pendiente_pago"]);
  if (!orden) return { ok: false, error: "NO_HAY_ORDEN" };
  if (!orden.numero_mesa) return { ok: false, error: "FALTA_MESA" };

  const { data: enviadosAhora, error: updErr } = await supabase
    .from("detalle_orden")
    .update({ enviado_cocina: true })
    .eq("orden_id", orden.id)
    .eq("enviado_cocina", false)
    .select("id,producto_nombre,cantidad,notas,consumidor");

  if (updErr) throw new Error(updErr.message);
  if (!enviadosAhora || enviadosAhora.length === 0) return { ok: false, error: "NO_HAY_PENDIENTES" };

  await recalcAndUpdateOrderTotal(orden.id);
  const clienteActualizado = await bumpVisitasIfNewDay(telefono);

  await supabase.from("kds_events").insert({ orden_id: orden.id, items_count: enviadosAhora.length });

  const nombreCliente = cliente?.nombre ? String(cliente.nombre).trim() : "Anónimo";
  const lines = enviadosAhora.map((it) => {
    const cons = it.consumidor && it.consumidor !== "General" ? ` (${it.consumidor})` : "";
    const nota = it.notas ? `\n   Nota: ${it.notas}` : "";
    return `${it.cantidad}x ${it.producto_nombre}${cons}${nota}`;
  });

  const kdsText =
    `🔥 NUEVA COMANDA — MESA ${orden.numero_mesa}\n` +
    `Cliente: ${nombreCliente}\n` +
    `—\n${lines.join("\n")}\n` +
    `Hora: ${nowHHMM()}`;

  return {
    ok: true,
    orden_id: orden.id,
    numero_mesa: orden.numero_mesa,
    kds: { to: KDS_PHONE || null, text: kdsText },
    cliente: clienteActualizado || cliente || null
  };
}

async function ver_cuenta_detallada(telefono, modo = "total") {
  telefono = normalizePhone(telefono);
  assertNonEmpty(telefono, "telefono");

  const orden = await getLatestOrderByPhone(telefono, ["abierta", "pendiente_pago"]);
  if (!orden) return { ok: false, error: "NO_HAY_ORDEN" };

  const { data: rows, error } = await supabase
    .from("detalle_orden")
    .select("producto_nombre,cantidad,precio_unitario,subtotal,notas,consumidor,fecha_creacion")
    .eq("orden_id", orden.id)
    .order("fecha_creacion", { ascending: true });
  if (error) throw new Error(error.message);

  const items = rows || [];
  const totalCalc = items.reduce((sum, r) => sum + Number(r.subtotal || 0), 0);
  await supabase.from("ordenes").update({ total: totalCalc }).eq("id", orden.id);

  let receipt = `🧾 Cuenta — Mesa ${orden.numero_mesa || "?"}\nEstado: ${orden.estado}\n—\n`;

  if (modo === "split") {
    const map = new Map();
    for (const it of items) {
      const key = it.consumidor || "General";
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(it);
    }
    for (const [cons, list] of map.entries()) {
      receipt += `\n👤 ${cons}\n`;
      let sub = 0;
      for (const it of list) {
        receipt += `${it.cantidad}x ${it.producto_nombre} @ $${formatMoney(it.precio_unitario)} = $${formatMoney(it.subtotal)}\n`;
        if (it.notas) receipt += `   Nota: ${it.notas}\n`;
        sub += Number(it.subtotal || 0);
      }
      receipt += `Subtotal ${cons}: $${formatMoney(sub)}\n`;
    }
    receipt += `\nTOTAL: $${formatMoney(totalCalc)}\n`;
  } else {
    for (const it of items) {
      receipt += `${it.cantidad}x ${it.producto_nombre} @ $${formatMoney(it.precio_unitario)} = $${formatMoney(it.subtotal)}\n`;
      if (it.notas) receipt += `   Nota: ${it.notas}\n`;
    }
    receipt += `—\nTOTAL: $${formatMoney(totalCalc)}\n`;
  }

  return { ok: true, orden_id: orden.id, numero_mesa: orden.numero_mesa, estado: orden.estado, modo, total: totalCalc, items, receiptText: receipt.trim() };
}

async function iniciar_pago(telefono) {
  telefono = normalizePhone(telefono);
  assertNonEmpty(telefono, "telefono");

  const orden = await getLatestOrderByPhone(telefono, ["abierta", "pendiente_pago"]);
  if (!orden) return { ok: false, error: "NO_HAY_ORDEN" };

  const { error } = await supabase.from("ordenes").update({ estado: "pendiente_pago" }).eq("id", orden.id);
  if (error) throw new Error(error.message);

  const cuenta = await ver_cuenta_detallada(telefono, "total");
  return { ok: true, orden_id: orden.id, cuenta };
}

async function procesar_pago(telefono, tipo) {
  telefono = normalizePhone(telefono);
  assertNonEmpty(telefono, "telefono");

  const t = String(tipo || "").trim().toLowerCase();
  if (!["link", "cash"].includes(t)) throw new Error("tipo inválido (usa 'link' o 'cash')");

  const cuenta = await ver_cuenta_detallada(telefono, "total");
  if (!cuenta.ok) return cuenta;

  await supabase.from("ordenes").update({ estado: "pendiente_pago" }).eq("id", cuenta.orden_id);

  const paymentLink = await get_config("payment_link", "https://link.mercadopago.com.mx/pagolcdc");

  if (t === "link") {
    return { ok: true, tipo: "link", customerText: `Aquí está tu link de pago:\n${paymentLink}\nTotal: $${formatMoney(cuenta.total)}` };
  }

  const mesa = cuenta.numero_mesa || "?";
  const staffText =
    `💵 SOLICITUD DE PAGO (EFECTIVO/TERMINAL)\nMESA ${mesa}\nTEL: ${telefono}\nTOTAL: $${formatMoney(cuenta.total)}\nAcción: Enviar mesero/terminal`;

  return {
    ok: true,
    tipo: "cash",
    customerText: "Listo. Pronto irán a ayudarte con el pago.",
    staffAlert: { to: ADMIN_PHONE || null, text: staffText }
  };
}

async function registro_wifi(telefono, email, fecha_nacimiento) {
  telefono = normalizePhone(telefono);
  assertNonEmpty(telefono, "telefono");

  const em = String(email || "").trim().toLowerCase();
  const fn = String(fecha_nacimiento || "").trim();

  if (!isValidEmail(em)) return { ok: false, error: "EMAIL_INVALIDO" };
  if (!isValidISODate(fn)) return { ok: false, error: "FECHA_INVALIDA" };

  await identificar_cliente(telefono, null);

  const { data, error } = await supabase
    .from("clientes")
    .update({ email: em, fecha_nacimiento: fn, ultimo_mensaje: new Date().toISOString() })
    .eq("telefono", telefono)
    .select("*")
    .maybeSingle();
  if (error) throw new Error(error.message);

  return { ok: true, cliente: data, wifiPassword: "cacahuate99", customerText: "¡Listo! Ya quedaste en el Club VIP ✅ Tu clave de WiFi es: cacahuate99" };
}

async function llamar_mesero(telefono, motivo) {
  telefono = normalizePhone(telefono);
  assertNonEmpty(telefono, "telefono");
  const m = String(motivo || "").trim();
  if (!m) return { ok: false, error: "MOTIVO_REQUERIDO" };

  const orden = await getLatestOrderByPhone(telefono, ["abierta", "pendiente_pago"]);
  const mesa = orden?.numero_mesa || "?";
  const staffText = `🙋‍♂️ LLAMADO DE MESERO\nMESA ${mesa}\nTEL: ${telefono}\nMotivo: ${m}\nHora: ${nowHHMM()}`;

  return { ok: true, customerText: "Listo, ya avisé. En breve te apoyan 🙌", staffAlert: { to: ADMIN_PHONE || null, text: staffText } };
}

async function como_va_mi_pedido(telefono) {
  telefono = normalizePhone(telefono);
  assertNonEmpty(telefono, "telefono");

  const orden = await getLatestOrderByPhone(telefono, ["abierta", "pendiente_pago"]);
  if (!orden) return { ok: false, error: "NO_HAY_ORDEN" };

  const { data: ev, error } = await supabase
    .from("kds_events")
    .select("sent_at,items_count")
    .eq("orden_id", orden.id)
    .order("sent_at", { ascending: false })
    .limit(1);

  if (error) throw new Error(error.message);

  const last = ev?.[0] || null;
  if (!last) {
    return { ok: true, text: `📦 Estado — Mesa ${orden.numero_mesa || "?"}\nAún no se ha enviado a cocina.\nConfirma con “✅ Enviar a cocina”.` };
  }

  const sentAt = new Date(last.sent_at);
  const mins = Math.max(0, Math.round((Date.now() - sentAt.getTime()) / 60000));
  let est = "En preparación 👨‍🍳";
  if (mins >= 5 && mins < 20) est = "Cocinándose 🔥";
  if (mins >= 20) est = "Por salir / empaque 📦";

  return { ok: true, text: `📦 Estado — Mesa ${orden.numero_mesa || "?"}\nÚltimo envío a cocina: ${sentAt.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} (hace ${mins} min)\nEstatus estimado: ${est}` };
}

async function solicitar_factura(telefono, rfc, email) {
  telefono = normalizePhone(telefono);
  assertNonEmpty(telefono, "telefono");

  const R = String(rfc || "").trim().toUpperCase();
  const E = String(email || "").trim().toLowerCase();

  if (!isValidRFC(R)) return { ok: false, error: "RFC_INVALIDO" };
  if (!isValidEmail(E)) return { ok: false, error: "EMAIL_INVALIDO" };

  const { error } = await supabase.from("facturacion_solicitudes").insert({ telefono, rfc: R, email: E, csf_recibida: false });
  if (error) throw new Error(error.message);

  return {
    ok: true,
    text:
      "🧾 Solicitud de factura registrada ✅\n" +
      "Para completar, envíanos tu CSF y ticket a info@lcdc.store\n" +
      "o por este chat después de pagar."
  };
}

async function guardar_rating(telefono, rating, comment = null) {
  telefono = normalizePhone(telefono);
  assertNonEmpty(telefono, "telefono");
  const r = Number(rating);
  if (!Number.isInteger(r) || r < 1 || r > 5) throw new Error("rating inválido");

  const { error } = await supabase.from("reviews_feedback").insert({ telefono, rating: r, comment: comment ? String(comment) : null });
  if (error) throw new Error(error.message);
  return { ok: true };
}

async function getPromoText() {
  const dow = new Date().getDay();
  const { data, error } = await supabase.from("promos").select("text").eq("dow", dow).maybeSingle();
  if (error) throw new Error(error.message);
  return `🔥 Promo del día\n${data?.text || "Hoy no hay promo publicada. Pregunta al mesero 🙌"}`;
}

async function getMenuCategories() {
  const { data, error } = await supabase
    .from("menu")
    .select("categoria")
    .eq("disponible", true);
  if (error) throw new Error(error.message);
  const set = new Set((data || []).map((x) => String(x.categoria || "Otros")));
  return [...set].sort();
}

async function getFaqsList() {
  const { data, error } = await supabase.from("faqs").select("id,title,orden").order("orden", { ascending: true });
  if (error) throw new Error(error.message);
  return data || [];
}

async function getFaqById(id) {
  const { data, error } = await supabase.from("faqs").select("title,body").eq("id", id).maybeSingle();
  if (error) throw new Error(error.message);
  return data || null;
}

async function saveChatMessage(telefono, direction, text, wa_message_id = null) {
  const { error } = await supabase.from("chat_messages").insert({ telefono, direction, text: text || null, wa_message_id: wa_message_id || null });
  if (error) console.warn("[chat_messages insert]", error.message);
}

module.exports = {
  supabase,
  ADMIN_PHONE,
  KDS_PHONE,

  get_config,
  getPromoText,

  identificar_cliente,
  consultar_menu,
  asegurar_orden_abierta,
  previsualizar_pedido,
  cancelar_item_sin_enviar,
  confirmar_comanda_cocina,
  ver_cuenta_detallada,
  iniciar_pago,
  procesar_pago,
  registro_wifi,
  llamar_mesero,
  como_va_mi_pedido,
  solicitar_factura,
  guardar_rating,

  getMenuCategories,
  getFaqsList,
  getFaqById,
  saveChatMessage
};
