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

  const { data, error } = await supabase
    .from("clientes")
    .update(patch)
    .eq("telefono", telefono)
    .select("*")
    .maybeSingle();

  if (error) throw new Error(error.message);
  return data || null;
}

async function consultar_menu(categoria_opcional) {
 let q = supabase
  .from("menu")
  .select("id,nombre,descripcion,precio,categoria,disponible,wa_retailer_id,es_extra")
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

    // --- AQUÍ SUMAMOS LA VISITA SOLO CUANDO ES UNA CUENTA NUEVA ---
    try {
      const { data: client } = await supabase.from("clientes").select("visitas").eq("telefono", telefono).maybeSingle();
      if (client) {
        await supabase.from("clientes").update({ visitas: (client.visitas || 0) + 1 }).eq("telefono", telefono);
      }
    } catch (err) {
      console.error("Error sumando visita:", err);
    }
    // --------------------------------------------------------------

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

// Función auxiliar para quitar acentos y normalizar texto
function quitarAcentos(str) {
  return String(str || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim();
}
async function mapRetailerIdsToMenuItems(orderItems) {
  if (!Array.isArray(orderItems) || orderItems.length === 0) {
    return { resolved: [], missing: [] };
  }

  const retailerIds = [...new Set(
    orderItems.map((x) => String(x.product_retailer_id || "").trim()).filter(Boolean)
  )];

  if (!retailerIds.length) {
    return { resolved: [], missing: [] };
  }

  const { data, error } = await supabase
    .from("menu")
    .select("id,nombre,precio,categoria,disponible,wa_retailer_id")
    .in("wa_retailer_id", retailerIds)
    .eq("disponible", true);

  if (error) throw new Error(error.message);

  const map = new Map((data || []).map((m) => [String(m.wa_retailer_id).trim(), m]));

  const resolved = [];
  const missing = [];

  for (const it of orderItems) {
    const key = String(it.product_retailer_id || "").trim();
    const found = map.get(key);

    if (!found) {
      missing.push(key);
      continue;
    }

    resolved.push({
      producto_nombre: found.nombre,
      cantidad: Number(it.quantity || 1),
      consumidor: it.consumidor ? String(it.consumidor).trim() : "General",
      notas: it.notas ? String(it.notas).trim() : null
    });
  }

  return { resolved, missing };
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
  .select("nombre,precio,disponible,categoria,es_extra")
  .eq("disponible", true);
if (menuAllErr) throw new Error(menuAllErr.message);

const menuMapExact = new Map((menuAll || []).map((m) => [String(m.nombre).trim(), m]));
const menuMapFlexible = new Map((menuAll || []).map((m) => [quitarAcentos(m.nombre), m]));

for (const it of normalized) {
  const searchName = quitarAcentos(it.producto_nombre);
  if (menuMapFlexible.has(searchName)) {
    it.producto_nombre = menuMapFlexible.get(searchName).nombre;
  }
}

const nombres = [...new Set(normalized.map((x) => String(x.producto_nombre).trim()))];
const missing = nombres.filter((n) => !menuMapExact.has(n));

if (missing.length) {
  const alternativas = (menuAll || [])
    .filter((m) => m.es_extra !== true)
    .filter((m) => !["Toppings", "Extras", "Add-ons", "Ingredientes"].includes(String(m.categoria || "").trim()))
    .slice(0, 8)
    .map((m) => ({
      nombre: m.nombre,
      categoria: m.categoria,
      precio: m.precio
    }));

  return { ok: false, error: "PRODUCTOS_NO_DISPONIBLES", missing, alternativas };
}
const rowsToInsert = normalized.map((it, idx) => {
  const keyExact = String(it.producto_nombre || "").trim();
  const keyFlexible = quitarAcentos(it.producto_nombre || "");

  const m = menuMapExact.get(keyExact) || menuMapFlexible.get(keyFlexible);

  if (!m) {
    throw new Error(`No pude resolver el precio del item #${idx + 1}: ${it.producto_nombre}`);
  }

  const nombreFinal = String(m.nombre || "").trim();
  const precio_unitario = Number(m.precio);
  const subtotal = precio_unitario * it.cantidad;

  return {
    orden_id: orden.id,
    producto_nombre: nombreFinal,
    cantidad: it.cantidad,
    precio_unitario,
    subtotal,
    notas: it.notas,
    consumidor: it.consumidor,
    enviado_cocina: false
  };
});

// dedupe simple: si ya existe un pendiente idéntico, no lo reinserta
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
async function cancelar_item_sin_enviar(telefono, producto, consumidor_opcional = null) {
  try {
    const orden = await getLatestOrderByPhone(telefono, ["abierta", "pendiente_pago"]);
    if (!orden) return { ok: false, error: "NO_ORDER" };

    // Limpiamos un poco el nombre que manda la IA (quitamos 'con queso', etc para buscar mejor)
    const palabraClave = String(producto || "").trim().split(" ")[0]; // Ej: Si manda "Choripan con queso", solo busca "Choripan"

    // Buscamos el platillo usando .ilike() que permite buscar coincidencias parciales sin importar mayúsculas
    let query = supabase
      .from("detalle_orden") // ⚠️ CAMBIA ESTO por el nombre real de tu tabla (ej: orden_items)
      .select("*")
      .eq("orden_id", orden.id)
      .eq("enviado_cocina", false)
      .ilike("producto_nombre", `%${palabraClave}%`); 

    if (consumidor_opcional && consumidor_opcional !== "General") {
      query = query.eq("consumidor", consumidor_opcional);
    }

    const { data: items, error: errSearch } = await query;

    if (errSearch) throw errSearch;
    if (!items || items.length === 0) return { ok: false, error: "No encontré ese platillo en los pendientes." };

    // Borramos el primer platillo que coincida (por si pidió 2 y solo quiere quitar 1)
    const itemABorrar = items[0];
    
    const { error: errDelete } = await supabase
      .from("detalle_orden") // ⚠️ CAMBIA ESTO TAMBIÉN
      .delete()
      .eq("id", itemABorrar.id);

    if (errDelete) throw errDelete;

    return { ok: true, producto: itemABorrar.producto_nombre, message: "Item eliminado correctamente." };
  } catch (err) {
    console.error("Error cancelar_item:", err);
    return { ok: false, error: err.message };
  }
}

async function confirmar_comanda_cocina(telefono) {
  telefono = normalizePhone(telefono);
  assertNonEmpty(telefono, "telefono");

  try {
    // 1. Buscamos la orden
    const orden = await getLatestOrderByPhone(telefono, ["abierta", "pendiente_pago"]);
    if (!orden) return { ok: false, error: "NO_ORDER" };
    if (!orden.numero_mesa) return { ok: false, error: "FALTA_MESA" };

    // 2. Buscamos qué platillos faltan por enviar a la cocina
    const { data: pendientes, error: errPendientes } = await supabase
      .from("detalle_orden")
      .select("*")
      .eq("orden_id", orden.id)
      .eq("enviado_cocina", false);

    if (errPendientes) throw errPendientes;
    if (!pendientes || pendientes.length === 0) {
      return { ok: false, error: "NO_HAY_PENDIENTES" };
    }

    // 3. Los marcamos como "enviados" en la base de datos
    const { error: errUpdate } = await supabase
      .from("detalle_orden")
      .update({ enviado_cocina: true })
      .eq("orden_id", orden.id)
      .eq("enviado_cocina", false);

    if (errUpdate) throw errUpdate;
    const { error: errKdsEvent } = await supabase
  .from("kds_events")
  .insert({
    orden_id: orden.id,
    items_count: pendientes.length
  });

if (errKdsEvent) {
  console.error("No se pudo registrar kds_event:", errKdsEvent.message);
}

    // --- FUNCIÓN RECUPERADA: Actualizar fecha de última compra ---
    try {
      await supabase
        .from("clientes")
        .update({ ultimo_mensaje: new Date().toISOString() })
        .eq("telefono", telefono);
    } catch (errDb) {
      console.error("No se pudo actualizar ultimo_mensaje:", errDb);
    }
    // -------------------------------------------------------------

    // 4. Armamos el ticket (el mensaje que le llegará al staff/cocina)
    let ticket = `🛎️ NUEVA ORDEN - MESA ${orden.numero_mesa}\n`;
    ticket += `Cliente: ${telefono}\n\n`;
    
    for (const item of pendientes) {
      const cons = item.consumidor && item.consumidor !== "General" ? ` (${item.consumidor})` : "";
      ticket += `[${item.cantidad}x] ${item.producto_nombre}${cons}\n`;
      if (item.notas) ticket += `   📝 Nota: ${item.notas}\n`;
    }

    // 5. Devolvemos el ticket para que index.js lo mande al KDS_PHONE
    return {
      ok: true,
      kds: {
        to: process.env.KDS_PHONE, 
        text: ticket.trim()
      }
    };
    
  } catch (error) {
    console.error("Error en confirmar_comanda_cocina:", error);
    return { ok: false, error: error.message };
  }
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
// --- NUEVO: Cierra la cuenta automáticamente después del timer ---
async function cerrarCuentaFinal(telefono) {
  try {
    const orden = await getLatestOrderByPhone(telefono, ["abierta", "pendiente_pago"]);
    if (orden) {
      await supabase
        .from("ordenes")
        .update({ estado: "cerrada" })
        .eq("id", orden.id);
      console.log(`✅ Cuenta de ${telefono} (Mesa ${orden.numero_mesa}) cerrada automáticamente.`);
    }
  } catch (error) {
    console.error("❌ Error cerrando la cuenta final:", error);
  }
}
// --- NUEVO: Sistema VIP de Despedida y Cashback ---
async function procesarDespedidaVip(telefono) {
  try {
    const orden = await getLatestOrderByPhone(telefono, ["abierta", "pendiente_pago"]);
    if (!orden) return null;

    const gastado = orden.total || 0;
    const puntosGanados = Math.floor(gastado * 0.05); // 5% de cashback

    // Buscar al cliente para sumar sus puntos
    const { data: cliente } = await supabase.from("clientes").select("nombre, puntos, visitas").eq("telefono", telefono).maybeSingle();
    const nuevosPuntos = (cliente?.puntos || 0) + puntosGanados;

    // Guardar los nuevos puntos en la base de datos
    if (cliente) {
      await supabase.from("clientes").update({ puntos: nuevosPuntos }).eq("telefono", telefono);
    }

    // Cerramos la cuenta automáticamente usando la función que ya hicimos
    await cerrarCuentaFinal(telefono);

    return {
      nombre: cliente?.nombre || "VIP",
      visitas: cliente?.visitas || 1,
      gastado: gastado,
      ganados: puntosGanados,
      totalPuntos: nuevosPuntos,
      mesa: orden.numero_mesa
    };
  } catch (err) {
    console.error("Error en VIP:", err);
    return null;
  }
}
// --- NUEVO: Borrar todos los items no enviados (Cancelar orden) ---
async function cancelar_orden_completa(telefono) {
  try {
    const orden = await getLatestOrderByPhone(telefono, ["abierta", "pendiente_pago"]);
    if (!orden) return { ok: false, error: "NO_ORDER" };

    const { error } = await supabase
      .from("detalle_orden") // Usando tu tabla correcta
      .delete()
      .eq("orden_id", orden.id)
      .eq("enviado_cocina", false);

    if (error) throw error;
    return { ok: true, message: "Todos los items pendientes fueron eliminados." };
  } catch (err) {
    console.error("Error cancelar_orden_completa:", err);
    return { ok: false, error: err.message };
  }
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
  mapRetailerIdsToMenuItems,
  cancelar_item_sin_enviar,
  cancelar_orden_completa,

  confirmar_comanda_cocina,
  ver_cuenta_detallada,
  iniciar_pago,
  procesar_pago,
  registro_wifi,
  llamar_mesero,
  como_va_mi_pedido,
  cerrarCuentaFinal,
  solicitar_factura,
  guardar_rating,
  procesarDespedidaVip,

  getMenuCategories,
  getFaqsList,
  getFaqById,
  saveChatMessage
};
