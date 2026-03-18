/* eslint-disable no-console */
require("dotenv").config({ path: require("path").join(__dirname, ".env") });

const express = require("express");
const axios = require("axios");
const OpenAI = require("openai");

const tools = require("./tools");
const { handleAdminText } = require("./admin");

// -------------------- Env --------------------
const PORT = process.env.PORT || 3000;

const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const WHATSAPP_PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID;
const WHATSAPP_VERIFY_TOKEN = process.env.WHATSAPP_VERIFY_TOKEN;
const WHATSAPP_API_VERSION = process.env.WHATSAPP_API_VERSION || "v20.0";

// --- NUEVO MULTI-ADMIN ---
const ADMIN_PHONES = (process.env.ADMIN_PHONES || process.env.ADMIN_PHONE || "5212225687851").split(",").map(s => s.trim());
const ADMIN_CONSOLE_TOKEN = process.env.ADMIN_CONSOLE_TOKEN || "";
const DEBUG_WEBHOOK = process.env.DEBUG_WEBHOOK === "1";

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

// (opcional) logs de arranque
console.log("✅ Boot");
console.log("ENV CHECK SUPABASE_URL =", process.env.SUPABASE_URL);
console.log("ENV CHECK SUPABASE_KEY present =", !!process.env.SUPABASE_KEY);
console.log("ENV CHECK WHATSAPP_PHONE_NUMBER_ID present =", !!WHATSAPP_PHONE_NUMBER_ID);
console.log("ADMINISTRADORES REGISTRADOS:", ADMIN_PHONES);

// -------------------- Clients --------------------
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });
const axiosClient = axios.create({ timeout: 15000 });

// -------------------- WhatsApp Helpers --------------------
function waMessagesUrl() {
  if (!WHATSAPP_PHONE_NUMBER_ID) {
    throw new Error("Falta WHATSAPP_PHONE_NUMBER_ID en .env");
  }
  return `https://graph.facebook.com/${WHATSAPP_API_VERSION}/${WHATSAPP_PHONE_NUMBER_ID}/messages`;
}

function waHeaders() {
  if (!WHATSAPP_TOKEN) throw new Error("Falta WHATSAPP_TOKEN en .env");
  return { Authorization: `Bearer ${WHATSAPP_TOKEN}`, "Content-Type": "application/json" };
}

async function sendText(to, text, opts = {}) {
  const url = waMessagesUrl();
  const payload = { messaging_product: "whatsapp", to, type: "text", text: { body: text } };
  try {
    await axiosClient.post(url, payload, { headers: waHeaders() });
  } catch (err) {
    console.error("❌ WhatsApp sendText status:", err.response?.status);
    console.error("❌ WhatsApp sendText data:", err.response?.data);
    throw err;
  }
  if (!opts.skipSave) {
    try { await tools.saveChatMessage(to, "out", text, null); } catch {}
  }
}

// --- FUNCIÓN PARA AVISAR A TODOS LOS ADMINS ---
async function notifyAdmins(text) {
  for (const admin of ADMIN_PHONES) {
    if (admin) {
      try { await sendText(admin, text, { skipSave: true }); } catch (e) {}
    }
  }
}

async function sendImage(to, imageUrl, caption) {
  const url = waMessagesUrl();
  const payload = { messaging_product: "whatsapp", to, type: "image", image: { link: imageUrl, caption } };
  try { await axiosClient.post(url, payload, { headers: waHeaders() }); } catch (e) { console.error("Error sendImage", e.message); }
}

async function sendListCustom(to, bodyText, buttonText, sections) {
  const url = waMessagesUrl();
  const payload = {
    messaging_product: "whatsapp", to, type: "interactive",
    interactive: { type: "list", body: { text: bodyText }, action: { button: buttonText, sections } }
  };
  try { await axiosClient.post(url, payload, { headers: waHeaders() }); } catch (e) { console.error("Error sendList", e.message); }
}

async function sendButtons(to, bodyText, buttons, opts = {}) {
  if (!Array.isArray(buttons)) throw new Error("buttons debe ser array");
  if (buttons.length > 3) throw new Error("máximo 3 botones");

  const url = waMessagesUrl();
  const payload = {
    messaging_product: "whatsapp",
    to,
    type: "interactive",
    interactive: {
      type: "button",
      body: { text: bodyText },
      action: {
        buttons: buttons.map((b) => ({
          type: "reply",
          reply: { id: b.id, title: b.title },
        })),
      },
    },
  };

  try {
    await axiosClient.post(url, payload, { headers: waHeaders() });
  } catch (err) {
    console.error("❌ WhatsApp sendButtons status:", err.response?.status);
    console.error("❌ WhatsApp sendButtons data:", err.response?.data);
    throw err;
  }

  if (!opts.skipSave) {
    try { await tools.saveChatMessage(to, "out", bodyText, null); } catch {}
  }
}

async function sendListMenu(to, opts = {}) {
  const url = waMessagesUrl();
  const payload = {
    messaging_product: "whatsapp",
    to,
    type: "interactive",
    interactive: {
      type: "list",
      body: { text: "Menú Principal" },
      action: {
        button: "Ver opciones",
        sections: [
          {
            title: "Atención y Pedidos",
            rows: [
              { id: "btn_ver_menu", title: "📖 Mostrar menú" },
              { id: "btn_ordenar", title: "🍕 Ordenar" },
              { id: "btn_ver_cuenta", title: "📝 Ver mi Cuenta" },
              { id: "btn_status", title: "📦 Estado de mi pedido" },
              { id: "btn_mesero", title: "🙋‍♂️ Llamar Mesero" }
            ],
          },
          {
            title: "Más Opciones",
            rows: [
              { id: "btn_promo", title: "🔥 Promo del día" },
              { id: "btn_faqs", title: "❓ Dudas Frecuentes" },
              { id: "btn_facturar", title: "🧾 Facturar" },
              { id: "btn_resena", title: "⭐ Dejar Reseña" },
              { id: "btn_wifi", title: "📶 Club VIP / WiFi" }
            ],
          }
        ],
      },
    },
  };

  try {
    await axiosClient.post(url, payload, { headers: waHeaders() });
  } catch (err) {
    console.error("❌ WhatsApp sendListMenu status:", err.response?.status);
    console.error("❌ WhatsApp sendListMenu data:", err.response?.data);
    throw err;
  }

  if (!opts.skipSave) {
    try { await tools.saveChatMessage(to, "out", "Menú Principal", null); } catch {}
  }
}

async function sendGoMenu(to, bodyText = "¿Qué hacemos ahora?", extraButtons = []) {
  const btn = { id: "go_menu", title: "🔙 Menú Principal" };
  const merged = [...extraButtons, btn].slice(0, 3);
  await sendButtons(to, bodyText, merged);
}

// -------------------- P0: Sesiones persistentes --------------------
const sessionCache = new Map(); // telefono -> {session, loadedAt}
const SESSION_CACHE_TTL_MS = 30 * 60 * 1000;

function defaultSession() {
  return {
    history: [],
    state: "NEW",
    mesa: null,
    split_mode: null,
    carrito_pendiente: null,
    last_preview: null,
    name_attempts: 0,
    human_mode: false,
    timers: { followUpAt: null, goodbyeAt: null },
    lastActivity: Date.now(),
    lastRating: null,
  };
}

async function loadSession(telefono) {
  const cached = sessionCache.get(telefono);
  if (cached && Date.now() - cached.loadedAt < SESSION_CACHE_TTL_MS) return cached.session;

  const { data, error } = await tools.supabase
    .from("bot_sessions")
    .select("data")
    .eq("telefono", telefono)
    .maybeSingle();

  if (error) throw new Error(error.message);

  const s = data?.data ? data.data : defaultSession();
  if (!Array.isArray(s.history)) s.history = [];
  if (typeof s.lastActivity !== "number") s.lastActivity = Date.now();

  sessionCache.set(telefono, { session: s, loadedAt: Date.now() });
  return s;
}

async function saveSession(telefono, session) {
  session.updated_at = new Date().toISOString();
  await tools.supabase
    .from("bot_sessions")
    .upsert(
      { telefono, data: session, updated_at: new Date().toISOString() },
      { onConflict: "telefono" }
    );
  sessionCache.set(telefono, { session, loadedAt: Date.now() });
}

function pushHistory(s, role, content) {
  s.history.push({ role, content });
  if (s.history.length > 20) s.history = s.history.slice(-20);
}
function touch(s) { s.lastActivity = Date.now(); }

// -------------------- P0: Rate limit básico --------------------
function checkRateLimit(s) {
  const now = Date.now();
  if (!s._rl) s._rl = [];
  s._rl.push(now);
  s._rl = s._rl.filter((t) => now - t < 10000);
  return s._rl.length <= 12;
}

// -------------------- Timers persistentes (best-effort) --------------------
async function maybeFireTimers(to, s) {
  const now = Date.now();

  if (s.timers?.followUpAt && now >= s.timers.followUpAt) {
    s.timers.followUpAt = null;
    await sendButtons(to, "¿Se te antoja algo más? Solo di ‘Ordenar’ o elige aquí 👇", [
      { id: "btn_ordenar", title: "🍕 Ordenar" },
      { id: "go_menu", title: "🔙 Menú Principal" },
    ]);
  }

  if (s.timers?.goodbyeAt && now >= s.timers.goodbyeAt) {
    s.timers.goodbyeAt = null;
    await sendText(to, "Gracias por visitar La Casita del Choripán, fue un honor atenderte hoy. Te esperamos pronto 🏠");
    await sendGoMenu(to, "¿Algo más?");
  }
}
function setFollowUp15(s) { s.timers.followUpAt = Date.now() + 15 * 60 * 1000; }
function setGoodbye5(s, from) {
  if (s._paymentTimerId) {
    clearTimeout(s._paymentTimerId);
    s._paymentTimerId = null;
  }

  s._paymentTimerId = setTimeout(async () => {
    try {
      await tools.cerrarCuentaFinal(from); 
      await sendText(from, "¡Gracias por visitar La Casita Del Choripan! Fue un honor atenderte hoy, te esperamos pronto. 🏠");
      await sendButtons(from, "¿Necesitas algo más?", [{ id: "go_menu", title: "🔙 Menú Principal" }]);
      const freshSession = defaultSession();
      await saveSession(from, freshSession);
    } catch (err) {
      console.error("Error en el timer de despedida:", err);
    }
  }, 300000); 
}

// -------------------- Determinismo básico --------------------
function isGreeting(text) {
  const t = String(text || "").trim().toLowerCase();
  return ["hola", "hello", "buenas", "buenos dias", "buenas tardes", "buenas noches"].includes(t);
}
function tryParseMesa(text) {
  const m = String(text || "").match(/mesa\s*(\d+)/i);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isInteger(n) || n <= 0) return null;
  return n;
}
function extractMesaNumber(text) {
  const raw = String(text || "").trim().toLowerCase();
  if (/^\d+$/.test(raw)) return Number(raw);
  const m = raw.match(/mesa\s*(\d+)/i);
  if (m) return Number(m[1]);
  if (raw.includes("llevar")) return 99;
  return null;
}

function normalizeCatalogId(v) {
  return String(v || "").trim();
}

async function sendNativeCatalogFlow(to, s) {
  const catalogId = process.env.WHATSAPP_CATALOG_ID;

  if (!catalogId) {
    await sendText(to, "No encontré el catálogo nativo configurado. Te mostraré el menú alterno.");
    if (typeof sendMenuCategories === "function") {
      await sendMenuCategories(to);
    } else {
      await sendGoMenu(to, "Elige una opción del menú para continuar.", [{ id: "btn_ver_menu", title: "📋 Mostrar menú" }]);
    }
    return;
  }

  const url = waMessagesUrl();
  const payload = {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to,
    type: "interactive",
    interactive: {
      type: "catalog_message",
      body: { text: "Agrega tus productos al carrito nativo de WhatsApp y envíamelo por aquí." },
      action: { name: "catalog_message" }
    }
  };

  try {
    await axiosClient.post(url, payload, { headers: waHeaders() });
    await sendText(to, "Cuando termines tu carrito, envíamelo y te mostraré el resumen para confirmarlo.");
  } catch (err) {
    console.error("❌ Error enviando catálogo nativo:", err.response?.data || err.message);
    await sendText(to, "No pude abrir el catálogo nativo. Te mostraré el menú alterno.");
    if (typeof sendMenuCategories === "function") {
      await sendMenuCategories(to);
    } else {
      await sendGoMenu(to, "Elige una opción del menú para continuar.", [{ id: "btn_ver_menu", title: "📋 Mostrar menú" }]);
    }
  }
}

async function askOrderMode(to, s) {
  s.state = "ORDER_MODE";
  await sendButtons(to, "¿Cómo quieres manejar la cuenta?", [
    { id: "order_one", title: "🧾 Una sola" },
    { id: "order_split", title: "👥 Dividir" },
    { id: "go_menu", title: "🔙 Menú Principal" },
  ]);
}

async function processPendingCart(from, s) {
  if (!Array.isArray(s.carrito_pendiente) || s.carrito_pendiente.length === 0) return false;
  if (!s.mesa) return false;

  let itemsParaMandar = [];

  if (typeof tools.mapRetailerIdsToMenuItems === "function") {
    const { resolved, missing } = await tools.mapRetailerIdsToMenuItems(s.carrito_pendiente);
    if ((!resolved || resolved.length === 0) && missing?.length) {
      await sendText(from, `❌ No pude identificar estos productos del catálogo:\n- ${missing.join("\n- ")}`);
      return true;
    }
    itemsParaMandar = resolved || [];
    if (missing?.length) {
      await sendText(from, `⚠️ No pude identificar algunos productos del catálogo y no los agregué:\n- ${missing.join("\n- ")}`);
    }
  } else {
    itemsParaMandar = s.carrito_pendiente.map((p) => ({
      producto_nombre: normalizeCatalogId(p.product_retailer_id),
      cantidad: Number(p.quantity || 1),
      consumidor: "General",
      notas: null
    }));
  }

  const preview = await tools.previsualizar_pedido(from, s.mesa, itemsParaMandar);

  if (preview?.ok) {
    s.last_preview = {
      orden_id: preview.orden_id,
      total_pendiente: preview.total_pendiente,
      ts: Date.now()
    };
    s.state = "ORDER_PREVIEW";
    s.carrito_pendiente = null;
    await sendPreview(from, preview);
    return true;
  }

  if (preview?.error === "PRODUCTOS_NO_DISPONIBLES") {
    let msg = `❌ No pude mapear algunos productos del carrito:\n- ${preview.missing.join("\n- ")}`;
    if (preview.alternativas?.length) {
      msg += `\n\nOpciones parecidas:\n${preview.alternativas.map((a) => `• ${a.nombre}`).join("\n")}`;
    }
    await sendText(from, msg);
    return true;
  }

  await sendText(from, "No pude procesar tu carrito. Inténtalo nuevamente.");
  return true;
}

// -------------------- Menú por categorías --------------------
async function sendMenuCategories(to) {
  const cats = await tools.getMenuCategories();
  if (!cats.length) {
    await sendText(to, "Por ahora no tengo productos disponibles.");
    await sendGoMenu(to);
    return;
  }
  const url = waMessagesUrl();
  const rows = cats.slice(0, 9).map((c) => ({ id: `menu_cat:${c}`, title: c }));
  const payload = {
    messaging_product: "whatsapp",
    to,
    type: "interactive",
    interactive: {
      type: "list",
      body: { text: "📖 Menú\nElige una categoría:" },
      action: { button: "Ver categorías", sections: [{ title: "Categorías", rows }] },
    },
  };
  await axiosClient.post(url, payload, { headers: waHeaders() });
  try { await tools.saveChatMessage(to, "out", "Menú categorías", null); } catch {}
}

async function sendMenuByCategory(to, categoria) {
  const r = await tools.consultar_menu(categoria);
  const items = r.items || [];
  if (!items.length) {
    await sendText(to, `No hay productos disponibles en: ${categoria}`);
    await sendGoMenu(to);
    return;
  }
  let txt = `📖 ${categoria}:\n`;
  for (const it of items) txt += `• ${it.nombre} — $${Number(it.precio).toFixed(2)}\n`;
  const menuVisual = await tools.get_config("menu_visual_url", "https://is.gd/j0142M");
  txt += `\n📲 Menú visual: ${menuVisual}`;
  await sendText(to, txt.trim());
  await sendGoMenu(to);
}

// -------------------- FAQs --------------------
async function sendFaqsList(to) {
  const list = await tools.getFaqsList();
  if (!list.length) {
    await sendText(to, "Aún no tengo FAQs configuradas.");
    await sendGoMenu(to);
    return;
  }
  const url = waMessagesUrl();
  const rows = list.slice(0, 9).map((f) => ({
    id: `faq:${f.id}`,
    title: String(f.title || "").slice(0, 24)
  })); 
  const payload = {
    messaging_product: "whatsapp",
    to,
    type: "interactive",
    interactive: {
      type: "list",
      body: { text: "Preguntas Frecuentes ❓\nElige un tema:" },
      action: { button: "Ver FAQs", sections: [{ title: "Temas", rows }] },
    },
  };
  await axiosClient.post(url, payload, { headers: waHeaders() });
  try { await tools.saveChatMessage(to, "out", "FAQs list", null); } catch {}
}

// -------------------- OpenAI tool calling (ORDERING) --------------------
const toolDefs = [
  {
    type: "function",
    function: {
      name: "consultar_menu",
      description: "Lista menú disponible=true.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: { categoria_opcional: { type: ["string", "null"] } },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "previsualizar_pedido",
      description: "Inserta pendientes enviado_cocina=false.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          telefono: { type: "string" },
          numero_mesa: { type: "integer" },
          items: {
            type: "array",
            minItems: 1,
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                producto_nombre: { type: "string" },
                cantidad: { type: "integer", minimum: 1 },
                notas: { type: ["string", "null"] },
                consumidor: { type: ["string", "null"] },
              },
              required: ["producto_nombre", "cantidad"],
            },
          },
        },
        required: ["telefono", "numero_mesa", "items"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "cancelar_item_sin_enviar",
      description: "Borra un item pendiente.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          telefono: { type: "string" },
          producto: { type: "string" },
          consumidor_opcional: { type: ["string", "null"] },
        },
        required: ["telefono", "producto"],
      },
    },
  },
];

async function executeTool(name, args) {
  if (name === "consultar_menu") return { __tool: name, ...(await tools.consultar_menu(args.categoria_opcional ?? null)) };
  if (name === "previsualizar_pedido") return { __tool: name, ...(await tools.previsualizar_pedido(args.telefono, args.numero_mesa, args.items)) };
  if (name === "cancelar_item_sin_enviar") return { __tool: name, ...(await tools.cancelar_item_sin_enviar(args.telefono, args.producto, args.consumidor_opcional ?? null)) };
  throw new Error(`Tool desconocida: ${name}`);
}

async function runToolCalling(messages) {
  for (let i = 0; i < 4; i++) {
    const resp = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages,
      tools: toolDefs,
      tool_choice: "auto",
    });

    const msg = resp.choices?.[0]?.message;
    if (!msg) return messages;

    if (msg.tool_calls?.length) {
      messages.push(msg);
      for (const tc of msg.tool_calls) {
        const out = await executeTool(tc.function.name, JSON.parse(tc.function.arguments || "{}"));
        messages.push({ role: "tool", tool_call_id: tc.id, content: JSON.stringify(out) });
      }
      continue;
    }
    messages.push(msg);
    return messages;
  }
  return messages;
}

function getLastToolOutput(messages, toolName) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role === "tool" && typeof m.content === "string") {
      try {
        const obj = JSON.parse(m.content);
        if (obj?.__tool === toolName) return obj;
      } catch {}
    }
  }
  return null;
}

// -------------------- Preview + Upsell --------------------
async function pickUpsellText() {
  const r = await tools.consultar_menu("Bebidas");
  const b = (r.items || [])[0];
  if (b) return `🥤 Sugerencia: ¿Te agrego *${b.nombre}* por $${Number(b.precio).toFixed(2)}?`;
  return "¿Te gustaría agregar algo más antes de mandarla a cocina? (Ej: bebida/postre)";
}

async function sendPreview(to, preview) {
  let txt = "Ok, tu orden por confirmar es:\n\n";
  for (const it of preview.pendientes || []) {
    const cons = it.consumidor && it.consumidor !== "General" ? ` (${it.consumidor})` : "";
    txt += `• ${it.cantidad}x ${it.producto_nombre}${cons} — $${Number(it.subtotal).toFixed(2)}\n`;
    if (it.notas) txt += `   Nota: ${it.notas}\n`;
  }
  txt += `\nTotal parcial: $${Number(preview.total_pendiente || 0).toFixed(2)}\n\n`;
  txt += await pickUpsellText();

  await sendButtons(to, txt.trim(), [
    { id: "confirm_kitchen", title: "✅ Enviar a cocina" },
    { id: "fix_order", title: "✏️ Corregir" },
    { id: "go_menu", title: "🔙 Menú Principal" },
  ]);
}

// -------------------- Orquestación principal --------------------
async function showMainMenu(to, s, greetingText = null) {
  if (greetingText) await sendText(to, greetingText);
  await sendListMenu(to);
  s.state = "MAIN_MENU";
}

async function askMesa(to, s) {
  s.state = "ASK_MESA";
  await sendText(to, "¿En qué mesa estás? (Ej: ‘Mesa 4’)");
  await sendGoMenu(to, "Cuando gustes, dime: Mesa 4");
}

async function goOrderingFlow(from, s) {
  if (!s.mesa) {
    s.state = "ASK_MESA";
    await sendText(from, "Primero necesito tu mesa. Ejemplo: 'Mesa 4' o solo '4'.");
    return;
  }
  if (!s.split_mode) {
    await askOrderMode(from, s);
    return;
  }
  s.state = "ORDERING";
  await sendText(from, "Perfecto. Agrega productos al carrito y envíamelo para sumarlos a tu cuenta actual.");
  await sendNativeCatalogFlow(from, s);
}

// -------------------- Consola web mínima (Estilizada y para App Review) --------------------
function adminConsoleAuth(req, res, next) {
  const token = req.query.token || req.headers["x-admin-token"];
  if (!ADMIN_CONSOLE_TOKEN || token !== ADMIN_CONSOLE_TOKEN) {
    return res.status(401).send(`
      <body style="font-family: sans-serif; background: #f4f6f8; display: flex; justify-content: center; align-items: center; height: 100vh;">
        <div style="background: white; padding: 40px; border-radius: 12px; box-shadow: 0 4px 12px rgba(0,0,0,0.1); text-align: center;">
          <h2 style="color: #d32f2f;">🛑 Acceso Denegado</h2>
          <p>Contraseña incorrecta o faltante.</p>
        </div>
      </body>
    `);
  }
  req.adminToken = token;
  next();
}

const htmlHeader = `
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; background-color: #f0f2f5; margin: 0; padding: 20px; color: #333; }
    .container { max-width: 800px; margin: 0 auto; background: #fff; border-radius: 12px; box-shadow: 0 4px 15px rgba(0,0,0,0.05); padding: 30px; }
    h2 { color: #b71c1c; border-bottom: 2px solid #ffeeee; padding-bottom: 10px; margin-top: 0; }
    a { color: #1976d2; text-decoration: none; font-weight: 500; }
    a:hover { text-decoration: underline; color: #0d47a1; }
    .btn { background: #d32f2f; color: white; border: none; padding: 10px 20px; border-radius: 8px; cursor: pointer; font-size: 16px; font-weight: bold; transition: 0.2s; }
    .btn:hover { background: #b71c1c; }
    .btn:disabled { background: #ccc; cursor: not-allowed; }
    .btn-quick { background: #e0e0e0; color: #333; border: none; padding: 6px 12px; border-radius: 6px; cursor: pointer; font-size: 13px; margin-right: 5px; margin-bottom: 5px; transition: 0.2s; }
    .btn-quick:hover { background: #bdbdbd; }
    textarea { width: 100%; box-sizing: border-box; padding: 12px; border: 1px solid #ccc; border-radius: 8px; font-family: inherit; font-size: 15px; resize: vertical; margin-bottom: 10px; }
    textarea:focus { outline: none; border-color: #d32f2f; box-shadow: 0 0 5px rgba(211,47,47,0.3); }
  </style>
`;

async function renderConsoleHome(token) {
  const { data, error } = await tools.supabase
    .from("bot_sessions")
    .select("telefono, updated_at")
    .order("updated_at", { ascending: false })
    .limit(50);
    
  if (error) return `<div class="container"><h3>Error</h3><pre>${error.message}</pre></div>`;

  const rows = (data || []).map((r) => {
    const date = new Date(r.updated_at).toLocaleString('es-MX', { timeZone: 'America/Mexico_City' });
    return `<li style="padding: 15px; border-bottom: 1px solid #eee; display: flex; justify-content: space-between; align-items: center;">
      <a href="/console/chat?tel=${r.telefono}&token=${token}" style="font-size: 17px;">📱 ${r.telefono}</a> 
      <small style="color: #888; background: #f9f9f9; padding: 4px 8px; border-radius: 12px;">⏱️ ${date}</small>
    </li>`;
  }).join("");

  return `
    <html>
      <head><title>Consola LCDC</title>${htmlHeader}</head>
      <body>
        <div class="container">
          <h2>🏠 La Casita - Centro de Mando</h2>
          <p style="color: #666; font-size: 15px;">Selecciona un chat reciente para espiar o intervenir:</p>
          <ul style="list-style: none; padding: 0; margin: 0;">${rows || "<li style='padding:15px; color:#888;'>Sin sesiones activas</li>"}</ul>
        </div>
      </body>
    </html>
  `;
}

async function renderConsoleChat(tel, token) {
  const { data, error } = await tools.supabase
    .from("chat_messages")
    .select("direction,text,created_at")
    .eq("telefono", tel)
    .order("created_at", { ascending: false })
    .limit(80);
    
  if (error) return `<div class="container"><h3>Error</h3><pre>${error.message}</pre></div>`;

  const msgs = (data || []).reverse().map((m) => {
    const isClient = m.direction === "in";
    const align = isClient ? "left" : "right";
    const bgColor = isClient ? "#e3f2fd" : "#ffebee";
    const who = isClient ? "🧑 Cliente" : "🤖 Beto / 🧑‍💼 Staff";
    const time = new Date(m.created_at).toLocaleTimeString('es-MX', { timeZone: 'America/Mexico_City', hour: '2-digit', minute:'2-digit' });
    
    return `
      <div style="text-align: ${align}; margin-bottom: 15px;">
        <div style="display: inline-block; max-width: 75%; background: ${bgColor}; padding: 12px 16px; border-radius: 16px; text-align: left; box-shadow: 0 1px 2px rgba(0,0,0,0.05);">
          <div style="font-size: 12px; color: #555; margin-bottom: 4px; font-weight: 600;">${who} <span style="font-weight: normal; font-size: 11px; float: right; margin-left: 10px;">${time}</span></div>
          <div style="font-size: 15px; line-height: 1.4; word-wrap: break-word;">${(m.text || "").replace(/</g, "&lt;").replace(/\n/g, "<br/>")}</div>
        </div>
      </div>
    `;
  }).join("");

  return `
    <html>
      <head><title>Chat ${tel}</title>${htmlHeader}</head>
      <body>
        <div class="container">
          <div style="display: flex; justify-content: space-between; align-items: center;">
            <h2 style="margin: 0; border: none;">💬 Chat: ${tel}</h2>
            <a href="/console?token=${token}" style="background: #eee; padding: 8px 12px; border-radius: 8px; color: #333;">⬅ Volver</a>
          </div>
          <hr style="border: none; border-top: 1px solid #eee; margin-bottom: 20px;" />

          <div style="background: #e3f2fd; padding: 20px; border-radius: 12px; margin-bottom: 20px; border: 1px solid #90caf9;">
            <h3 style="margin-top:0; color: #1565c0; font-size: 16px;">🛡️ Panel de Pruebas (Meta App Review)</h3>
            
            <div style="margin-bottom: 10px;">
              <button class="btn-quick" onclick="document.getElementById('demoText').value='Prueba App Review Meta - mensaje enviado desde mi aplicación independiente.'">Mensaje App Review</button>
              <button class="btn-quick" onclick="document.getElementById('demoText').value='Hola, este es un saludo de prueba para revisión.'">Saludo Demo</button>
              <button class="btn-quick" onclick="document.getElementById('demoText').value='Mensaje de prueba con Timestamp: ' + new Date().toISOString()">Timestamp</button>
            </div>

            <textarea id="demoText" rows="2">Prueba App Review Meta - mensaje enviado desde mi aplicación independiente.</textarea>
            
            <div style="display: flex; gap: 10px; flex-wrap: wrap;">
              <button id="btnDemoSend" class="btn" style="background: #1565c0;" onclick="sendDemoMessage('${tel}', '${token}')">🚀 Enviar mensaje de prueba</button>
              <a href="https://wa.me/${tel}" target="_blank" class="btn" style="background: #2e7d32; text-decoration: none; display: inline-flex; align-items: center;">🟢 Abrir WhatsApp Web</a>
            </div>

            <pre id="demoResult" style="background: #222; color: #0f0; padding: 15px; border-radius: 8px; display: none; overflow-x: auto; margin-top: 15px; font-size: 13px;"></pre>
          </div>
          
          <div id="chat-box" style="background: #fafafa; padding: 20px; border: 1px solid #ddd; border-radius: 12px; height: 400px; overflow-y: auto; margin-bottom: 20px;">
            <div id="chat-messages">
              ${msgs || "<div style='text-align:center; color:#888;'>No hay mensajes en el historial</div>"}
            </div>
          </div>
          
          <form method="POST" action="/console/send?token=${token}" style="margin: 0;">
            <input type="hidden" name="tel" value="${tel}" />
            <textarea name="text" rows="2" placeholder="Escribe respuesta como soporte normal..."></textarea>
            <div style="text-align: right;">
              <button type="submit" class="btn">Enviar Soporte Normal</button>
            </div>
          </form>
        </div>

        <script>
          // 1. Script para enviar el mensaje Demo sin recargar (AJAX)
          async function sendDemoMessage(tel, token) {
            const btn = document.getElementById('btnDemoSend');
            const resultBox = document.getElementById('demoResult');
            const text = document.getElementById('demoText').value;
            
            if(!text.trim()) return alert("El mensaje no puede estar vacío");

            btn.disabled = true;
            btn.innerText = "Enviando...";
            resultBox.style.display = 'block';
            resultBox.innerText = "Procesando petición...";

            try {
              const res = await fetch('/console/send-demo?token=' + token, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ tel, text })
              });
              const json = await res.json();
              
              // Mostramos el JSON en pantalla para que Meta lo vea en el video
              resultBox.innerText = JSON.stringify(json, null, 2);
              if(!json.ok) resultBox.style.color = "#ff5252";
              else resultBox.style.color = "#00e676";
              
            } catch(e) {
              resultBox.style.color = "#ff5252";
              resultBox.innerText = "Error de red: " + e.message;
            } finally {
              btn.disabled = false;
              btn.innerText = "🚀 Enviar mensaje de prueba";
            }
          }

          // 2. Script Auto-Update (Corregido con wrapper invisible)
          const chatBox = document.getElementById('chat-box');
          const chatMessages = document.getElementById('chat-messages');
          
          // Scroll inicial al fondo
          if(chatBox) chatBox.scrollTop = chatBox.scrollHeight;

          setInterval(async () => {
            try {
              const response = await fetch(window.location.href);
              const htmlText = await response.text();
              
              const parser = new DOMParser();
              const doc = parser.parseFromString(htmlText, 'text/html');
              const newContent = doc.getElementById('chat-messages').innerHTML;

              if (chatMessages.innerHTML !== newContent) {
                // Checamos si el usuario estaba viendo lo más reciente
                const isAtBottom = chatBox.scrollHeight - chatBox.clientHeight <= chatBox.scrollTop + 50;
                
                chatMessages.innerHTML = newContent; // Solo actualizamos los mensajes
                
                if (isAtBottom) {
                  chatBox.scrollTop = chatBox.scrollHeight;
                }
              }
            } catch (err) { /* Errores de red silenciados para no llenar la consola */ }
          }, 3000);
        </script>
      </body>
    </html>
  `;
}

// -------------------- Express --------------------
const app = express();
app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true }));

app.get("/", (_req, res) => res.json({ ok: true }));
app.get("/health", (_req, res) => res.json({ ok: true }));

// Consola Rutas
app.get("/console", adminConsoleAuth, async (req, res) => { 
  res.send(await renderConsoleHome(req.adminToken)); 
});

app.get("/console/chat", adminConsoleAuth, async (req, res) => {
  const tel = String(req.query.tel || "");
  if (!tel) return res.status(400).send("Falta tel");
  res.send(await renderConsoleChat(tel, req.adminToken));
});

app.post("/console/send", adminConsoleAuth, async (req, res) => {
  const tel = String(req.body.tel || "");
  const text = String(req.body.text || "").trim();
  if (!tel || !text) return res.status(400).send("Falta tel/text");
  await sendText(tel, `🧑‍💼 Soporte: ${text}`);
  res.redirect(`/console/chat?tel=${tel}&token=${req.adminToken}`);
});

// NUEVO ENDPOINT PARA META APP REVIEW (JSON Response)
app.post("/console/send-demo", adminConsoleAuth, async (req, res) => {
  const tel = String(req.body.tel || "");
  const text = String(req.body.text || "").trim();
  
  if (!tel || !text) {
    return res.status(400).json({ ok: false, error: "Faltan parámetros: teléfono o texto." });
  }

  try {
    // Mandamos el mensaje directo sin guardarlo en el historial de IA para no ensuciar la sesión
    await sendText(tel, text, { skipSave: true }); 
    
    // Respondemos con el JSON de éxito que el revisor de Meta quiere ver
    res.json({
      ok: true,
      status: "sent",
      recipient: tel,
      message_body: text,
      timestamp: new Date().toISOString()
    });
  } catch (err) {
    res.status(500).json({
      ok: false,
      error: err.message || "Error al comunicarse con la API de WhatsApp."
    });
  }
});

// Webhook verify
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
  if (mode === "subscribe" && token === WHATSAPP_VERIFY_TOKEN) return res.status(200).send(challenge);
  return res.sendStatus(403);
});

// Webhook messages 
app.post("/webhook", async (req, res) => {
  try {
    if (DEBUG_WEBHOOK) console.dir(req.body, { depth: null });
    const entry = req.body?.entry?.[0];
    const change = entry?.changes?.[0];
    const value = change?.value;
    const message = value?.messages?.[0];

    if (!message) return res.sendStatus(200);

    const from = message.from;
    const messageId = message.id || null;
    const text = message?.text?.body || null;
    const listId = message?.interactive?.list_reply?.id || null;
    const buttonId = message?.interactive?.button_reply?.id || null;
    const orderItems = message?.order?.product_items || null;

    if (messageId) {
      const { error: insErr } = await tools.supabase.from("wa_inbox").insert({ message_id: messageId, telefono: from });
      if (insErr) {
        const msg = String(insErr.message || "").toLowerCase();
        if (msg.includes("duplicate") || msg.includes("already exists")) return res.sendStatus(200);
      }
    }
    try {
      const logText = orderItems ? "[CARRITO_CATALOGO]" : (text || `[interactive:${listId || buttonId}]`);
      await tools.saveChatMessage(from, "in", logText, messageId);
    } catch {}

    res.sendStatus(200);

    setImmediate(() => {
      handleIncoming(from, { text, listId, buttonId, orderItems })
        .catch((e) => console.error("handleIncoming Error:", e?.message || e));
    });

  } catch (e) {
    console.error("❌ Error en /webhook:", e?.message);
    if (!res.headersSent) res.sendStatus(200);
  }
}); 

// ============================================================================
// ==================== FUNCION PRINCIPAL DE MANEJO DE MENSAJES =================
// ============================================================================
async function handleIncoming(from, input) {
  const s = await loadSession(from);
  touch(s);

  if (!checkRateLimit(s)) {
    await sendText(from, "⚠️ Estoy recibiendo muchos mensajes. Dame 10 segundos.");
    await saveSession(from, s);
    return;
  }

  await maybeFireTimers(from, s);

  let text = input.text || null;
  const listId = input.listId || null;
  const buttonId = input.buttonId || null;
  const actionId = listId || buttonId || null;
  const orderItems = input.orderItems || null;

  // --- Bypass del Carrito ---
  if (orderItems) {
    s.state = "ORDERING";
    const normalizedCart = orderItems.map((p) => ({
      product_retailer_id: normalizeCatalogId(p.product_retailer_id),
      quantity: Number(p.quantity || 1)
    }));

    if (!s.mesa) {
      s.carrito_pendiente = normalizedCart;
      s.state = "ASK_MESA";
      await sendText(from, "Recibí tu carrito ✅\n\nAntes de procesarlo necesito tu mesa. Ejemplo: 'Mesa 4' o solo '4'.");
      await saveSession(from, s);
      return;
    }

    if (!s.split_mode) {
      s.carrito_pendiente = normalizedCart;
      await askOrderMode(from, s);
      await saveSession(from, s);
      return;
    }

    s.carrito_pendiente = normalizedCart;
    await processPendingCart(from, s);
    await saveSession(from, s);
    return;
  }

  // --- ADMIN determinista (AHORA MULTI-ADMIN) ---
  if (ADMIN_PHONES.includes(from)) {
    if (!text) { await sendText(from, "Admin: envía comandos por texto. Escribe: admin help"); return; }
    const reply = await handleAdminText(text);
    if (reply && reply.startsWith("{")) {
      try {
        const obj = JSON.parse(reply);
        if (obj.__action === "SEND_TO_CLIENT" && obj.to && obj.text) {
          await sendText(obj.to, `🧑‍💼 Soporte: ${obj.text}`);
          await sendText(from, `✅ Enviado a ${obj.to}`);
          return;
        }
        if (obj.__action === "RELEASE_CLIENT" && obj.to) {
          sessionCache.delete(obj.to);
          await sendText(obj.to, "🤖 Nuestro equipo ha finalizado el chat. ¡Beto está de vuelta para ayudarte!");
          await sendGoMenu(obj.to);
          await sendText(from, `✅ El cliente ${obj.to} ha sido liberado.`);
          return;
        }
      } catch {}
    }
    await sendText(from, reply);
    return;
  }

  // --- ONBOARDING PREMIUM ---
  if (s.state === "NEW" || (text && isGreeting(text) && !["ASK_NAME_1", "ASK_NAME_2", "ORDERING"].includes(s.state))) {
    let cliente = null;
    try { cliente = (await tools.identificar_cliente(from, null)).cliente; } catch {}
    const yaTieneNombre = cliente && cliente.nombre && String(cliente.nombre).trim() !== "";

    if (yaTieneNombre) {
      s.nombre_cliente = cliente.nombre;
      let msg = `Hola ${cliente.nombre}, qué gusto verte de nuevo. 🏠\n\n`;
      if (cliente.puntos && Number(cliente.puntos) > 0) {
        msg += `💎 Te recuerdo que cuentas con $${cliente.puntos} pesitos a tu favor para tu próxima compra.\n\n`;
      }
      msg += `Comencemos. ¿Qué deseas hacer hoy?`;
      await sendButtons(from, msg, [
        { id: "btn_assign_table", title: "🪑 Asignar Mesa" },
        { id: "btn_info_casita", title: "ℹ️ La Casita Info" }
      ]);
      s.state = "MAIN_MENU";
      await saveSession(from, s);
      return;
    } else {
      let msg = `¡Hola! Soy Beto 🤖, bienvenido a La Casita Del Choripán y estoy aquí para ayudarte.\n\nPuedo mostrarte el menú, tomarte la orden, llamar al mesero, darte info del Wi-Fi y mucho más.\n\nPara empezar, ¿cuál es tu nombre?`;
      await sendText(from, msg);
      s.state = "ASK_NAME_1";
      s.name_attempts = 1;
      await saveSession(from, s);
      return;
    }
  }

  // Lógica Intentos Nombre
  if ((s.state === "ASK_NAME_1" || s.state === "ASK_NAME_2") && text) {
    if (text.trim().length >= 2 && text.trim().length <= 40) {
      const name = text.trim();
      s.nombre_cliente = name;
      await tools.identificar_cliente(from, name); 
      await sendButtons(from, `Hola ${name}, nos da gusto conocerte. ¡Comencemos!\n\n¿Qué deseas hacer hoy?`, [
        { id: "btn_assign_table", title: "🪑 Asignar Mesa" },
        { id: "btn_info_casita", title: "ℹ️ La Casita Info" }
      ]);
      s.state = "MAIN_MENU";
      await saveSession(from, s);
      return;
    }
    if (s.name_attempts === 1) {
      s.name_attempts = 2;
      s.state = "ASK_NAME_2";
      await sendText(from, "Tu nombre es importante para darte un servicio personalizado y que acumules puntos VIP.\n¿Me compartes cómo te gustaría que te diga?");
      await saveSession(from, s);
      return;
    }
    await sendText(from, "Está bien, no te preocupes. Continuemos como invitado.");
    await sendButtons(from, "¿Qué deseas hacer hoy?", [
      { id: "btn_assign_table", title: "🪑 Asignar Mesa" },
      { id: "btn_info_casita", title: "ℹ️ La Casita Info" }
    ]);
    s.state = "MAIN_MENU";
    await saveSession(from, s);
    return;
  }

  // Modo Humano
  if (s.state === "HUMAN_CHAT" && s.human_mode) {
    if (actionId === "go_menu") { await showMainMenu(from, s); await saveSession(from, s); return; }
    if (text) {
      await notifyAdmins(`📩 Cliente ${from}: ${text}`);
      await sendText(from, "✅ Recibido. En breve te responden.");
      await saveSession(from, s);
      return;
    }
  }


  // =========================================================================
  // ==================== MANEJADORES DE TODOS LOS BOTONES ===================
  // =========================================================================

  if (actionId === "go_menu") { await showMainMenu(from, s); await saveSession(from, s); return; }

  if (actionId === "btn_info_casita") {
    const sections = [{
      title: "Explora La Casita",
      rows: [
        { id: "btn_know_menu", title: "📖 Conocer Menú" },
        { id: "btn_promo", title: "🔥 Promo del día" },
        { id: "btn_faqs", title: "❓ Dudas Frecuentes" },
        { id: "btn_facturar", title: "🧾 Facturar" },
        { id: "btn_resena", title: "⭐ Dejar Reseña" },
        { id: "btn_wifi", title: "📶 Club VIP / WiFi" }
      ]
    }];
    await sendListCustom(from, "Información de La Casita Del Choripán", "Ver Opciones", sections);
    await saveSession(from, s);
    return;
  }

  if (actionId === "btn_assign_table") {
    const sections = [{
      title: "Selecciona tu ubicación",
      rows: [
        { id: "set_mesa_1", title: "Mesa 1" },
        { id: "set_mesa_2", title: "Mesa 2" },
        { id: "set_mesa_3", title: "Mesa 3" },
        { id: "set_mesa_4", title: "Mesa 4" },
        { id: "set_mesa_99", title: "Para Llevar" } 
      ]
    }];
    await sendListCustom(from, "Asignación de Mesa", "Elegir Mesa", sections);
    await saveSession(from, s);
    return;
  }

  if (actionId && actionId.startsWith("set_mesa_")) {
    const mesaNum = parseInt(actionId.replace("set_mesa_", ""), 10);
    s.mesa = mesaNum; 
    s.state = "TABLE_ASSIGNED";
    await tools.asegurar_orden_abierta(from, mesaNum);
    const textoMesa = mesaNum === 99 ? "Para Llevar" : `Mesa ${mesaNum}`;
    await sendText(from, `✅ Listo, te registré en ${textoMesa}.`);
    await askOrderMode(from, s);
    await saveSession(from, s);
    return;
  }

  if (actionId === "start_ordering" || actionId === "btn_ordenar") {
    await goOrderingFlow(from, s);
    await saveSession(from, s);
    return;
  }

  if (actionId === "btn_know_menu") {
    const linksString = await tools.get_config("menu_foto_url", "https://ipvdftmptwelqauaxcpw.supabase.co/storage/v1/object/public/Menu/Menu%20-%201.png,https://ipvdftmptwelqauaxcpw.supabase.co/storage/v1/object/public/Menu/Menu%20-%202.png"); 
    const links = linksString.split(",");
    for (let i = 0; i < links.length; i++) {
      const caption = (i === links.length - 1) ? "¡Aquí tienes nuestro menú completo! 🤤" : ""; 
      await sendImage(from, links[i].trim(), caption);
    }
    await sendButtons(from, "¿Listo para pedir?", [
      { id: "btn_assign_table", title: "🪑 Asignar Mesa / Pedir" },
      { id: "btn_humano", title: "🧑‍💼 Hablar con humano" }
    ]);
    await saveSession(from, s);
    return;
  }

  if (actionId === "btn_ver_menu") {
    await goOrderingFlow(from, s);
    await saveSession(from, s);
    return;
  }

  if (actionId === "btn_promo") { await sendText(from, await tools.getPromoText()); await sendGoMenu(from); await saveSession(from, s); return; }
  if (actionId === "btn_faqs") { await sendFaqsList(from); await saveSession(from, s); return; }
  
  if (actionId && actionId.startsWith("faq:")) {
    const faqId = actionId.split("faq:")[1];
    const f = await tools.getFaqById(faqId);
    await sendText(from, f ? `${f.title}\n${f.body}` : "No encontré ese FAQ.");
    await sendGoMenu(from);
    await saveSession(from, s);
    return;
  }

  if (actionId === "btn_facturar") {
    s.state = "FACTURA_COLLECT";
    await sendText(from, "🧾 Para facturar, compárteme: RFC y correo.\nEj: ABCD001122XXX, correo@dominio.com");
    await sendGoMenu(from);
    await saveSession(from, s);
    return;
  }

  if (actionId === "btn_resena") {
    const url = await tools.get_config("google_review_url", "https://google.com");
    await sendText(from, `⭐ ¡Gracias! Déjanos tu reseña aquí:\n${url}\n\nY califícanos rápido 👇`);
    await sendButtons(from, "Calificación rápida:", [
      { id: "rate_5", title: "😍 Excelente" },
      { id: "rate_4", title: "🙂 Bien" },
      { id: "rate_3", title: "😕 Regular" },
    ]);
    await saveSession(from, s);
    return;
  }

  if (actionId === "rate_5" || actionId === "rate_4" || actionId === "rate_3") {
    s.lastRating = actionId === "rate_5" ? 5 : actionId === "rate_4" ? 4 : 3;
    s.state = "REVIEW_COMMENT";
    await tools.guardar_rating(from, s.lastRating, null);
    await sendText(from, "¿Quieres dejar un comentario corto? (opcional). Si no, escribe “no”.");
    await sendGoMenu(from);
    await saveSession(from, s);
    return;
  }

  if (actionId === "btn_wifi") {
    s.state = "WIFI_COLLECT";
    await sendText(from, "Para darte la clave del WiFi y ofrecerte descuentos y promociones en tu cumpleaños, necesito registrarte en el Club VIP. ¿Me compartes tu correo y tu fecha de nacimiento? (Ej: correo@dominio.com, 2000-08-15)");
    await sendGoMenu(from);
    await saveSession(from, s);
    return;
  }

  if (actionId === "btn_mesero") {
    s.state = "MESERO_MOTIVO";
    await sendText(from, "Enseguida. ¿Cuál es el motivo?");
    await sendGoMenu(from);
    await saveSession(from, s);
    return;
  }

  if (actionId === "btn_status") {
    const out = await tools.como_va_mi_pedido(from);
    if (!out.ok) {
      if (out.error === "NO_HAY_ORDEN") { await sendText(from, "No encontré una orden activa en este momento."); } 
      else { await sendText(from, "No pude consultar el estado de tu pedido en este momento."); }
      await sendGoMenu(from);
      await saveSession(from, s);
      return;
    }
    await sendText(from, out.text);
    await sendGoMenu(from);
    await saveSession(from, s);
    return;
  }

  if (actionId === "btn_ver_cuenta") {
    const modo = s.split_mode === "split" ? "split" : "total";
    const out = await tools.ver_cuenta_detallada(from, modo);
    if (!out.ok) {
      if (out.error === "NO_HAY_ORDEN") { await sendText(from, "No encontré una cuenta activa en este momento."); } 
      else { await sendText(from, "No pude consultar tu cuenta en este momento."); }
      await sendGoMenu(from);
      await saveSession(from, s);
      return;
    }
    await sendText(from, out.receiptText);
    await sendButtons(from, "¿Qué deseas hacer ahora?", [
      { id: "start_payment", title: "💳 Pagar" },
      { id: "btn_ordenar", title: "➕ Agregar más" },
      { id: "go_menu", title: "🔙 Menú Principal" }
    ]);
    await saveSession(from, s);
    return;
  }

  if (actionId === "btn_humano") {
    s.state = "HUMAN_CHAT";
    s.human_mode = true;
    await notifyAdmins(`🧑‍💼 Cliente prefiere atención humana\nTEL: ${from}\nResponde con: enviar a ${from}: <mensaje>\nO usa consola: /console`);
    await sendText(from, "Listo. Ya avisé a un humano para que te atienda 🙌");
    await sendButtons(from, "¿Quieres volver al bot?", [
      { id: "go_menu", title: "🔙 Menú Principal" }
    ]);
    await saveSession(from, s);
    return;
  }

  if (actionId === "order_one" || actionId === "order_split") {
    s.split_mode = actionId === "order_split" ? "split" : "one";
    s.state = "ORDERING";
    await sendText(from, s.split_mode === "split" ? "Perfecto. Vamos a dividir la cuenta." : "Perfecto. Será una sola cuenta.");
    const resumed = await processPendingCart(from, s);
    if (!resumed) { await sendNativeCatalogFlow(from, s); }
    await saveSession(from, s);
    return;
  }

  if (actionId === "fix_order") {
    s.state = "ORDER_EDITING";
    await sendText(from, "Perfecto. Dime qué quieres corregir.\n\nEjemplos:\n- quitar 1 choripán\n- agregar 2 refrescos\n- cambiar una coca por agua");
    await saveSession(from, s);
    return;
  }

  if (actionId === "confirm_kitchen") {
    if (!s.last_preview?.orden_id) {
      await sendText(from, "No encontré una previsualización activa para confirmar.");
      await saveSession(from, s);
      return;
    }

    const out = await tools.confirmar_comanda_cocina(from);
    if (!out.ok) {
      if (out.error === "NO_HAY_PENDIENTES") { await sendText(from, "No tengo items pendientes por confirmar."); } 
      else if (out.error === "FALTA_MESA") { await sendText(from, "Antes de enviar a cocina necesito tu mesa. Ejemplo: 'Mesa 4' o solo '4'."); s.state = "ASK_MESA"; } 
      else { await sendText(from, "No pude enviar a cocina. Revisa tu orden e intenta de nuevo."); }
      await saveSession(from, s);
      return;
    }

    if (out.kds?.to && out.kds?.text) { try { await sendText(out.kds.to, out.kds.text); } catch {} }

    s.state = "ORDER_CONFIRMED";
    s.last_confirmed_at = Date.now();
    await sendText(from, "✅ Tu orden fue confirmada y enviada a cocina.");
    setFollowUp15(s);
    await sendButtons(from, "¿Deseas pedir algo más o revisar tu cuenta?", [
      { id: "btn_ordenar", title: "➕ Agregar más" },
      { id: "btn_ver_cuenta", title: "💳 Ver mi cuenta" },
      { id: "go_menu", title: "🔙 Menú Principal" }
    ]);
    await saveSession(from, s);
    return;
  }

  if (actionId === "start_payment") {
    const out = await tools.iniciar_pago(from);
    if (!out.ok) { await sendText(from, "No encontré una orden para pagar."); await sendGoMenu(from); await saveSession(from, s); return; }
    if (out.cuenta?.receiptText) await sendText(from, out.cuenta.receiptText);
    s.state = "PAYMENT_CHOICE";
    await sendButtons(from, "¿Cómo quieres pagar?", [
      { id: "pay_link", title: "💳 Link de pago" },
      { id: "pay_cash", title: "💵 Efectivo/Mesero" },
    ]);
    await saveSession(from, s);
    return;
  }

  if (actionId === "pay_link") {
    const out = await tools.procesar_pago(from, "link");
    await sendText(from, out.customerText);
    setGoodbye5(s, from); 
    await sendButtons(from, "¿Listo para retirarte?", [
      { id: "bye_vip", title: "👋 Ya me voy" },
      { id: "go_menu", title: "🔙 Menú Principal" }
    ]);
    await saveSession(from, s);
    return;
  }

  if (actionId === "pay_cash") {
    const out = await tools.procesar_pago(from, "cash");
    if (out.staffAlert?.to && out.staffAlert?.text) { try { await sendText(out.staffAlert.to, out.staffAlert.text); } catch {} }
    await sendText(from, out.customerText);
    setGoodbye5(s, from); 
    await sendButtons(from, "¿Listo para retirarte?", [
      { id: "bye_vip", title: "👋 Ya me voy" },
      { id: "go_menu", title: "🔙 Menú Principal" }
    ]);
    await saveSession(from, s);
    return;
  }

  if (actionId === "bye_vip") {
    if (s._paymentTimerId) { clearTimeout(s._paymentTimerId); s._paymentTimerId = null; }
    const vipData = await tools.procesarDespedidaVip(from);
    if (vipData && vipData.gastado > 0) {
      await sendText(from, `¡Gracias por tu visita, ${vipData.nombre}! 🌟\nHoy acumulaste $${vipData.ganados} pesitos.\nTienes un total de $${vipData.totalPuntos} para tu próxima compra.\n\n¡Te esperamos pronto! 🏠`);
      await notifyAdmins(`🔔 ALERTA VIP: El cliente ${vipData.nombre} (Visita #${vipData.visitas}) se retiró de la Mesa ${vipData.mesa}.\nGastó: $${vipData.gastado}\nGanó: $${vipData.ganados} pts.`);
    } else {
      await sendText(from, "¡Gracias por visitarnos! Fue un placer atenderte. Te esperamos pronto. 🏠");
      await tools.cerrarCuentaFinal(from);
    }
    await saveSession(from, defaultSession()); 
    return;
  }

  // =========================================================================
  // ========================= MANEJO DE TEXTO LIBRE =========================
  // =========================================================================

  if (text) {
    const t = text.trim().toLowerCase();

    // Atajos Globales de Emergencia
    if (t === "ordenar") { await goOrderingFlow(from, s); await saveSession(from, s); return; }
    if (t === "menu" || t === "menú" || t === "inicio") { await showMainMenu(from, s); await saveSession(from, s); return; }
    if (t.includes("salir") || t.includes("adiós") || t.includes("adios")) {
      await sendText(from, "¡Gracias por visitarnos! 👋 Te esperamos pronto. 🏠");
      await saveSession(from, defaultSession());
      return;
    }
    if (t.includes("humano") || t.includes("soporte") || t.includes("ayuda")) {
      s.state = "HUMAN_CHAT";
      s.human_mode = true;
      await notifyAdmins(`🧑‍💼 Cliente solicita atención humana\nTEL: ${from}`);
      await sendText(from, "Listo. Ya avisé a un humano para que te atienda 🙌");
      await sendButtons(from, "¿Quieres volver al bot?", [{ id: "go_menu", title: "🔙 Menú Principal" }]);
      await saveSession(from, s);
      return;
    }
    if (t.includes("cancelar")) {
      await tools.cancelar_orden_completa(from);
      await tools.cerrarCuentaFinal(from);
      await sendText(from, "✅ Listo, he cancelado tu orden completa y liberado tu mesa.");
      await saveSession(from, defaultSession()); 
      return;
    }

    // Estados Específicos
    if (s.state === "ASK_MESA") {
      const mesa = extractMesaNumber(text);
      if (!mesa) { await sendText(from, "No pude entender la mesa. Ejemplo: 'Mesa 4' o solo '4'."); await saveSession(from, s); return; }
      s.mesa = mesa;
      s.state = "TABLE_ASSIGNED";
      await tools.asegurar_orden_abierta(from, mesa);
      const textoMesa = mesa === 99 ? "Para Llevar" : `Mesa ${mesa}`;
      await sendText(from, `✅ Listo, te registré en ${textoMesa}.`);
      await askOrderMode(from, s);
      await saveSession(from, s);
      return;
    }

    if (s.state === "WIFI_COLLECT") {
      const m = text.split(",").map((x) => x.trim());
      if (m.length >= 2) {
        const out = await tools.registro_wifi(from, m[0], m[1]);
        if (!out.ok) { await sendText(from, "Formato inválido. Ejemplo: correo@dominio.com, 2000-08-15"); await sendGoMenu(from); await saveSession(from, s); return; }
        await sendText(from, out.customerText);
        await sendGoMenu(from);
        s.state = "MAIN_MENU";
        await saveSession(from, s);
        return;
      }
      await sendText(from, "Compárteme en este formato: correo@dominio.com, 2000-08-15");
      await sendGoMenu(from);
      await saveSession(from, s);
      return;
    }

    if (s.state === "MESERO_MOTIVO") {
      const out = await tools.llamar_mesero(from, text);
      if (out.staffAlert?.to && out.staffAlert?.text) { try { await sendText(out.staffAlert.to, out.staffAlert.text); } catch {} }
      await sendText(from, out.customerText);
      await sendGoMenu(from);
      s.state = "MAIN_MENU";
      await saveSession(from, s);
      return;
    }

    if (s.state === "FACTURA_COLLECT") {
      const parts = text.split(",").map((x) => x.trim());
      if (parts.length >= 2) {
        const out = await tools.solicitar_factura(from, parts[0], parts[1]);
        if (!out.ok) { await sendText(from, "Formato inválido. Ej: ABCD001122XXX, correo@dominio.com"); await sendGoMenu(from); await saveSession(from, s); return; }
        await sendText(from, out.text);
        await sendGoMenu(from);
        s.state = "MAIN_MENU";
        await saveSession(from, s);
        return;
      }
      await sendText(from, "Formato: RFC, correo@dominio.com");
      await sendGoMenu(from);
      await saveSession(from, s);
      return;
    }

    if (s.state === "REVIEW_COMMENT") {
      if (t !== "no" && t !== "nop" && t !== "n") { await tools.guardar_rating(from, s.lastRating || 5, text.trim()); }
      s.state = "MAIN_MENU";
      await sendText(from, "¡Gracias! 🙌");
      await sendGoMenu(from);
      await saveSession(from, s);
      return;
    }

    // --- ORDERING IA ---
    if (s.state === "ORDERING" || s.state === "ORDER_EDITING") {
      if (!s.mesa) { await askMesa(from, s); await saveSession(from, s); return; }

      const system = `
Eres Beto, el mesero experto de La Casita del Choripán.
DATOS OBLIGATORIOS PARA TUS TOOLS:
- telefono: "${from}"
- numero_mesa: ${s.mesa}
- nombre_cliente: "${s.nombre_cliente || 'General'}"

REGLAS DE PEDIDOS Y NOTAS (¡CRÍTICO!):
1. Si el cliente pide algo, usa previsualizar_pedido. NO repitas items que ya estén en su ticket. SOLO AGREGA LO NUEVO.
2. Si el cliente agrega INSTRUCCIONES ESPECIALES (ej: "sin chimichurri", "extra queso"), DEBES guardarlo en el campo 'notas'.
3. Si el cliente pide QUITAR o CANCELAR un platillo específico, usa 'cancelar_item_sin_enviar'.

REGLAS DE VENTAS Y UPSELLING:
1. Si pide "un choripan", asume cantidad 1.
2. Si pide "papa", pregúntale qué tipo: Clásicas, Gajo o Especiales.
3. REGLA DE ORO PARA EL UPSELLING: Si el cliente pide algo, TIENES QUE EJECUTAR la herramienta 'previsualizar_pedido' INMEDIATAMENTE para guardarlo en ese mismo turno. NUNCA hagas una sugerencia sin haber ejecutado la herramienta primero.
`.trim();

      const messages = [{ role: "system", content: system }, ...s.history, { role: "user", content: text }];
      const newMsgs = await runToolCalling(messages);

      pushHistory(s, "user", text);

      const lastMsg = newMsgs[newMsgs.length - 1];
      if (lastMsg && lastMsg.role === "assistant" && lastMsg.content) {
        pushHistory(s, "assistant", lastMsg.content);
      }

      const lastPreview = getLastToolOutput(newMsgs, "previsualizar_pedido");
      if (lastPreview) {
        if (lastPreview.ok === false && lastPreview.error === "PRODUCTOS_NO_DISPONIBLES") {
          let msg = `❌ No disponibles:\n- ${lastPreview.missing.join("\n- ")}\n`;
          if (lastPreview.alternativas?.length) msg += `\n✅ Alternativas:\n` + lastPreview.alternativas.slice(0, 6).map(a => `• ${a.nombre}`).join("\n");
          await sendText(from, msg.trim());
          await sendGoMenu(from);
          await saveSession(from, s);
          return;
        }
        if (lastPreview.ok === true) {
          s.last_preview = { orden_id: lastPreview.orden_id, total_pendiente: lastPreview.total_pendiente, ts: Date.now() };
          s.state = "ORDER_PREVIEW";
          await sendPreview(from, lastPreview);
          await saveSession(from, s);
          return;
        }
      }

      const lastCancel = getLastToolOutput(newMsgs, "cancelar_item_sin_enviar");
      if (lastCancel) {
        await sendText(from, lastCancel.ok ? `✅ Listo, quité: ${lastCancel.producto}` : "No encontré ese item pendiente para quitar.");
        await sendGoMenu(from);
        await saveSession(from, s);
        return;
      }

      if (lastMsg && lastMsg.role === "assistant" && lastMsg.content) {
        await sendText(from, lastMsg.content);
        await saveSession(from, s);
        return;
      }

      await sendText(from, "Ok. Dime tu pedido con producto y cantidad.");
      await sendGoMenu(from);
      await saveSession(from, s);
      return;
    }

    // --- Clasificador de Intenciones (Atrapa-Todo) ---
    const promptIntencion = `
El cliente acaba de decir: "${text}"
Clasifica su intención respondiendo ÚNICAMENTE con una palabra:
ADIOS (se despide)
CANCELAR (quiere cancelar orden completa)
MENU (pide ver carta)
AYUDA (quiere hablar con humano/mesero)
OTRO (cualquier otra cosa)
`;
    try {
      const respIA = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [{ role: "user", content: promptIntencion }],
        max_tokens: 10,
        temperature: 0,
      });

      const intencion = respIA.choices[0]?.message?.content?.trim().toUpperCase() || "OTRO";

      if (intencion === "ADIOS") {
        await sendText(from, "¡Gracias por visitarnos! Fue un placer atenderte. Te esperamos pronto. 👋🏠");
        await saveSession(from, defaultSession());
        return;
      }
      if (intencion === "CANCELAR") {
        await tools.cancelar_orden_completa(from); 
        await tools.cerrarCuentaFinal(from); 
        await sendText(from, "✅ Listo, he cancelado tu orden y liberado tu mesa.");
        await saveSession(from, defaultSession());
        return;
      }
      if (intencion === "AYUDA") {
        await sendButtons(from, "¿Necesitas asistencia?", [{ id: "btn_mesero", title: "🙋‍♂️ Llamar Mesero" }, { id: "btn_humano", title: "🧑‍💼 Chat con soporte" }]);
        await saveSession(from, s);
        return;
      }
    } catch (err) { console.error("Error clasificador:", err); }

    // Fallback por defecto
    await showMainMenu(from, s);
    await saveSession(from, s);
    return;

  } // <-- Fin del if (text)

  // Si envían una imagen o audio fuera de los flujos
  await sendText(from, "Aún no puedo procesar ese tipo de mensaje. Por favor usa los botones o texto.");
  await sendGoMenu(from);
  await saveSession(from, s);
}

// -------------------- Start --------------------
app.listen(PORT, () => console.log(`✅ Server running on http://localhost:${PORT}`));