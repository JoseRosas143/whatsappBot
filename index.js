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

const ADMIN_PHONE = process.env.ADMIN_PHONE || "5212225687851";
const ADMIN_CONSOLE_TOKEN = process.env.ADMIN_CONSOLE_TOKEN || "";
const DEBUG_WEBHOOK = process.env.DEBUG_WEBHOOK === "1";

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

// (opcional) logs de arranque
console.log("✅ Boot");
console.log("ENV CHECK SUPABASE_URL =", process.env.SUPABASE_URL);
console.log("ENV CHECK SUPABASE_KEY present =", !!process.env.SUPABASE_KEY);
console.log("ENV CHECK WHATSAPP_PHONE_NUMBER_ID present =", !!WHATSAPP_PHONE_NUMBER_ID);

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
            title: "Opciones",
            rows: [
              { id: "btn_ver_menu", title: "📖 Mostrar menú" },
              { id: "btn_ordenar", title: "🍕 Ordenar" },
              { id: "btn_ver_cuenta", title: "📝 Ver mi Cuenta" },
              { id: "btn_status", title: "📦 ¿Cómo va mi pedido?" },
              { id: "btn_promo", title: "🔥 Promo del día" },
              { id: "btn_faqs", title: "❓ Preguntas Frecuentes" },
              { id: "btn_facturar", title: "🧾 Facturar" },
              { id: "btn_resena", title: "⭐ Califícanos / Reseña" },
              { id: "btn_wifi", title: "📶 Club VIP / WiFi" },
              { id: "btn_mesero", title: "🙋‍♂️ Llamar Mesero" },
              { id: "btn_humano", title: "🧑‍💼 Prefiero atención humana" },
            ],
          },
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

async function sendStartScreen(to) {
  await sendButtons(to, "¡Hola! 👋 ¿Qué prefieres?", [
    { id: "start_human", title: "🧑‍💼 Hablar con una persona" },
    { id: "start_app", title: "🍽️ Iniciar App restaurante" },
  ]);
}

// -------------------- P0: Sesiones persistentes --------------------
const sessionCache = new Map(); // telefono -> {session, loadedAt}
const SESSION_CACHE_TTL_MS = 30 * 60 * 1000;

function defaultSession() {
  return {
    history: [],
    state: "NEW",
    mesa: null,
    split_mode: "one",
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
function setGoodbye5(s) { s.timers.goodbyeAt = Date.now() + 5 * 60 * 1000; }

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
  const rows = list.slice(0, 9).map((f) => ({ id: `faq:${f.id}`, title: f.title }));
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
      model: "gpt-4.1-mini",
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

async function askOrderMode(to, s) {
  s.state = "ORDER_MODE";
  await sendButtons(to, "¿Cómo quieres tu orden?", [
    { id: "order_one", title: "🧾 Una sola cuenta" },
    { id: "order_split", title: "➗ Dividir por persona" },
    { id: "go_menu", title: "🔙 Menú Principal" },
  ]);
}

async function askMesa(to, s) {
  s.state = "ASK_MESA";
  await sendText(to, "¿En qué mesa estás? (Ej: ‘Mesa 4’)");
  await sendGoMenu(to, "Cuando gustes, dime: Mesa 4");
}

// -------------------- Consola web mínima --------------------
function adminConsoleAuth(req, res, next) {
  const token = req.query.token || req.headers["x-admin-token"];
  if (!ADMIN_CONSOLE_TOKEN || token !== ADMIN_CONSOLE_TOKEN) return res.status(401).send("Unauthorized");
  next();
}

async function renderConsoleHome() {
  const { data, error } = await tools.supabase
    .from("bot_sessions")
    .select("telefono, updated_at")
    .order("updated_at", { ascending: false })
    .limit(50);

  if (error) return `<h3>Error</h3><pre>${error.message}</pre>`;

  const rows = (data || [])
    .map((r) => `<li><a href="/console/chat?tel=${r.telefono}">${r.telefono}</a> <small>${r.updated_at}</small></li>`)
    .join("");

  return `
    <h2>LCDc Bot Console</h2>
    <p>Chats recientes:</p>
    <ul>${rows || "<li>Sin sesiones</li>"}</ul>
  `;
}

async function renderConsoleChat(tel) {
  const { data, error } = await tools.supabase
    .from("chat_messages")
    .select("direction,text,created_at")
    .eq("telefono", tel)
    .order("created_at", { ascending: false })
    .limit(80);

  if (error) return `<h3>Error</h3><pre>${error.message}</pre>`;

  const msgs = (data || [])
    .reverse()
    .map((m) => {
      const who = m.direction === "in" ? "Cliente" : "Bot/Staff";
      return `<div style="margin:6px 0;"><b>${who}</b> <small>${m.created_at}</small><br/>${(m.text || "").replace(/</g, "&lt;")}</div>`;
    })
    .join("");

  return `
    <h2>Chat: ${tel}</h2>
    <div style="padding:10px;border:1px solid #ddd;border-radius:8px;max-width:900px;">${msgs || "Sin mensajes"}</div>
    <hr/>
    <form method="POST" action="/console/send">
      <input type="hidden" name="tel" value="${tel}" />
      <textarea name="text" rows="3" style="width:900px" placeholder="Escribe respuesta humana..."></textarea><br/>
      <button type="submit">Enviar</button>
    </form>
    <p><a href="/console">⬅ Volver</a></p>
  `;
}

// -------------------- Express --------------------
const app = express();
app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true }));

app.get("/", (_req, res) => res.json({ ok: true }));
app.get("/health", (_req, res) => res.json({ ok: true }));

// Consola
app.get("/console", adminConsoleAuth, async (_req, res) => {
  const html = await renderConsoleHome();
  res.send(html);
});
app.get("/console/chat", adminConsoleAuth, async (req, res) => {
  const tel = String(req.query.tel || "");
  if (!tel) return res.status(400).send("Falta tel");
  res.send(await renderConsoleChat(tel));
});
app.post("/console/send", adminConsoleAuth, async (req, res) => {
  const tel = String(req.body.tel || "");
  const text = String(req.body.text || "").trim();
  if (!tel || !text) return res.status(400).send("Falta tel/text");
  await sendText(tel, `🧑‍💼 Soporte: ${text}`);
  res.redirect(`/console/chat?tel=${tel}`);
});

// Webhook verify
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
  if (mode === "subscribe" && token === WHATSAPP_VERIFY_TOKEN) return res.status(200).send(challenge);
  return res.sendStatus(403);
});

// Webhook messages (UNICO)
app.post("/webhook", async (req, res) => {
  try {
    if (DEBUG_WEBHOOK) console.dir(req.body, { depth: null });

    const entry = req.body?.entry?.[0];
    const change = entry?.changes?.[0];
    const value = change?.value;
    const message = value?.messages?.[0];

    if (!message) return res.sendStatus(200);

    // Meta test (IDs falsos)
    const meta = value?.metadata;
    const isMetaTest =
      meta?.phone_number_id === "123456123" ||
      meta?.display_phone_number === "16505551111";

    if (isMetaTest) {
      console.log("🧪 Meta test webhook recibido. No procesaré flujo ni responderé.");
      return res.sendStatus(200);
    }

    const from = message.from;
    const messageId = message.id || null;

    const text = message?.text?.body || null;
    const listId = message?.interactive?.list_reply?.id || null;
    const buttonId = message?.interactive?.button_reply?.id || null;

    console.log("INBOUND:", { from, messageId, type: message.type, text, listId, buttonId });

    // Dedupe WA
    if (messageId) {
      const { error: insErr } = await tools.supabase.from("wa_inbox").insert({ message_id: messageId, telefono: from });
      if (insErr) {
        const msg = String(insErr.message || "").toLowerCase();
        if (msg.includes("duplicate") || msg.includes("already exists")) return res.sendStatus(200);
        console.warn("⚠️ wa_inbox insert error:", insErr.message);
      }
    }

    // log inbound
    try {
      await tools.saveChatMessage(from, "in", text || `[interactive:${listId || buttonId}]`, messageId);
    } catch {}

    // responder rápido
    res.sendStatus(200);

    // procesar async
    setImmediate(() => {
      handleIncoming(from, { text, listId, buttonId }).catch((e) => console.error("handleIncoming:", e?.message || e));
    });
  } catch (e) {
    console.error("❌ Error en /webhook:", e?.response?.data || e?.message || e);
    return res.sendStatus(200);
  }
});

// -------------------- Core Handler --------------------
async function handleIncoming(from, input) {
  const s = await loadSession(from);
  touch(s);

  if (!checkRateLimit(s)) {
    await sendText(from, "⚠️ Estoy recibiendo muchos mensajes muy rápido. Dame 10 segundos y volvemos a intentar.");
    await saveSession(from, s);
    return;
  }

  await maybeFireTimers(from, s);

  const text = input.text || null;
  const actionId = input.listId || input.buttonId || null;

  // ADMIN determinista (desde tu número admin por WhatsApp)
  if (from === ADMIN_PHONE) {
    if (!text) { await sendText(from, "Admin: envía comandos por texto. Escribe: admin help"); return; }

    const reply = await handleAdminText(text);

    // Acción enviar a cliente (si el admin handler devuelve JSON)
    if (reply && reply.startsWith("{")) {
      try {
        const obj = JSON.parse(reply);
        if (obj.__action === "SEND_TO_CLIENT" && obj.to && obj.text) {
          await sendText(obj.to, `🧑‍💼 Soporte: ${obj.text}`);
          await sendText(from, `✅ Enviado a ${obj.to}`);
          return;
        }
      } catch {}
    }

    await sendText(from, reply);
    return;
  }

  // Start screen
  if (s.state === "NEW" || (text && isGreeting(text) && s.state !== "STARTED")) {
    s.state = "STARTED";
    await sendStartScreen(from);
    await saveSession(from, s);
    return;
  }

  if (actionId === "start_human") {
    s.state = "HUMAN_CHAT";
    s.human_mode = true;

    await sendText(ADMIN_PHONE, `🧑‍💼 Cliente solicita atención humana\nTEL: ${from}\nResponde con: enviar a ${from}: <mensaje>\nO usa consola: /console`);
    await sendText(from, "Listo 🙌 Un humano te atenderá en breve. Puedes escribir tu mensaje aquí.");

    await sendButtons(from, "¿Quieres volver al bot?", [
      { id: "start_app", title: "🍽️ Iniciar App restaurante" },
      { id: "go_menu", title: "🔙 Menú Principal" },
    ]);

    await saveSession(from, s);
    return;
  }

  if (actionId === "start_app") {
    s.human_mode = false;
    s.state = "ASK_NAME_1";
    s.name_attempts = 1;
    await sendText(from, "¡Hola! Bienvenido a La Casita del Choripán. Para comenzar, ¿cuál es tu nombre?");
    await sendGoMenu(from);
    await saveSession(from, s);
    return;
  }

  // Modo humano: forward al admin
  if (s.state === "HUMAN_CHAT" && s.human_mode) {
    if (actionId === "go_menu") { await showMainMenu(from, s); await saveSession(from, s); return; }
    if (text) {
      await sendText(ADMIN_PHONE, `📩 Cliente ${from}: ${text}`);
      await sendText(from, "✅ Recibido. En breve te responden.");
      await saveSession(from, s);
      return;
    }
  }

  // go_menu global
  if (actionId === "go_menu") { await showMainMenu(from, s); await saveSession(from, s); return; }

  // sync cliente
  let cliente = null;
  try { cliente = (await tools.identificar_cliente(from, null)).cliente || null; } catch {}
  const needsName = !cliente?.nombre || !String(cliente.nombre).trim();

  // Nombre 2 intentos
  if ((s.state === "ASK_NAME_1" || s.state === "ASK_NAME_2") && text) {
    if (text.trim().length >= 2 && text.trim().length <= 40) {
      const name = text.trim();
      await tools.identificar_cliente(from, name);
      await showMainMenu(from, s, `¡Muchas gracias, ${name}! Estas son mis opciones:`);
      await saveSession(from, s);
      return;
    }
    if (s.name_attempts === 1) {
      s.name_attempts = 2;
      s.state = "ASK_NAME_2";
      await sendText(from, "Tu nombre es importante: nos ayuda a personalizar el servicio y a que participes en nuestro programa de recompensas. ¿Cómo te gustaría que te diga?");
      await sendGoMenu(from);
      await saveSession(from, s);
      return;
    }
    await sendText(from, "Está bien, continuemos.");
    await showMainMenu(from, s);
    await saveSession(from, s);
    return;
  }

  // Si ya “inició app” pero no tiene nombre, pedirlo
  if (needsName && s.state === "STARTED" && text) {
    s.state = "ASK_NAME_1";
    s.name_attempts = 1;
    await sendText(from, "¡Hola! Bienvenido a La Casita del Choripán. Para comenzar, ¿cuál es tu nombre?");
    await sendGoMenu(from);
    await saveSession(from, s);
    return;
  }

  // Acciones menú principal
  if (actionId === "btn_ver_menu") { await sendMenuCategories(from); await sendGoMenu(from, "Elige una categoría o vuelve al menú."); await saveSession(from, s); return; }
  if (actionId && actionId.startsWith("menu_cat:")) { await sendMenuByCategory(from, actionId.split("menu_cat:")[1]); await saveSession(from, s); return; }

  if (actionId === "btn_status") {
    const out = await tools.como_va_mi_pedido(from);
    await sendText(from, out.ok ? out.text : "Aún no tengo una orden activa.");
    await sendGoMenu(from);
    await saveSession(from, s);
    return;
  }

  if (actionId === "btn_promo") {
    await sendText(from, await tools.getPromoText());
    await sendGoMenu(from);
    await saveSession(from, s);
    return;
  }

  if (actionId === "btn_faqs") { await sendFaqsList(from); await sendGoMenu(from, "Selecciona un tema o vuelve al menú."); await saveSession(from, s); return; }
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

  if (actionId === "btn_humano") {
    s.state = "HUMAN_CHAT";
    s.human_mode = true;

    await sendText(ADMIN_PHONE, `🧑‍💼 Cliente prefiere atención humana\nTEL: ${from}\nResponde con: enviar a ${from}: <mensaje>\nO usa consola: /console`);
    await sendText(from, "Listo. Ya avisé a un humano para que te atienda 🙌");

    await sendButtons(from, "¿Quieres volver al bot?", [
      { id: "start_app", title: "🍽️ Iniciar App restaurante" },
      { id: "go_menu", title: "🔙 Menú Principal" },
    ]);

    await saveSession(from, s);
    return;
  }

  if (actionId === "btn_ordenar") { await askOrderMode(from, s); await saveSession(from, s); return; }

  if (actionId === "order_one") {
    s.split_mode = "one";
    s.state = "ORDERING";
    if (!s.mesa) { await askMesa(from, s); await saveSession(from, s); return; }
    await sendText(from, "Perfecto. Dime tu pedido (ej: '2 Choripán Clásico y 1 Agua Natural').");
    await sendGoMenu(from);
    await saveSession(from, s);
    return;
  }

  if (actionId === "order_split") {
    s.split_mode = "split";
    s.state = "ORDERING";
    await sendText(from, "Perfecto. Para dividir por consumo, dime así: ‘Ana quiere X y Yo quiero Y…’. Yo lo guardaré por persona.");
    if (!s.mesa) { await askMesa(from, s); await saveSession(from, s); return; }
    await sendGoMenu(from, "Dime tu pedido cuando gustes.");
    await saveSession(from, s);
    return;
  }

  if (actionId === "fix_order") {
    s.state = "ORDERING";
    await sendText(from, "Ok. Dime qué corregimos (puedes pedir más o decir 'quita X').");
    await sendGoMenu(from);
    await saveSession(from, s);
    return;
  }

  if (actionId === "confirm_kitchen") {
    const out = await tools.confirmar_comanda_cocina(from);

    if (!out.ok) {
      if (out.error === "NO_HAY_PENDIENTES") await sendText(from, "No tengo items pendientes por confirmar.");
      else if (out.error === "FALTA_MESA") { await sendText(from, "Antes de enviar a cocina necesito tu mesa. (Ej: ‘Mesa 4’)"); s.state = "ASK_MESA"; }
      else await sendText(from, "No pude enviar a cocina. Revisa tu orden e intenta de nuevo.");
      await sendGoMenu(from);
      await saveSession(from, s);
      return;
    }

    if (out.kds?.to && out.kds?.text) {
      try { await sendText(out.kds.to, out.kds.text); } catch {}
    }

    await sendText(from, "¡Listo! Ya lo mandé a cocina 👨‍🍳");
    setFollowUp15(s);
    await sendGoMenu(from);
    await saveSession(from, s);
    return;
  }

  if (actionId === "btn_ver_cuenta") {
    const modo = s.split_mode === "split" ? "split" : "total";
    const out = await tools.ver_cuenta_detallada(from, modo);
    await sendText(from, out.ok ? out.receiptText : "Aún no tengo una orden activa.");
    if (out.ok) {
      await sendButtons(from, "¿Qué deseas hacer?", [
        { id: "btn_ordenar", title: "🍕 Pedir más" },
        { id: "start_payment", title: "💳 Cerrar y pagar" },
        { id: "go_menu", title: "🔙 Menú Principal" },
      ]);
    } else {
      await sendGoMenu(from);
    }
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
      { id: "pay_cash", title: "💵 Efectivo / Terminal / Mesero" },
      { id: "go_menu", title: "🔙 Menú Principal" },
    ]);
    await saveSession(from, s);
    return;
  }

  if (actionId === "pay_link") {
    const out = await tools.procesar_pago(from, "link");
    await sendText(from, out.customerText);
    setGoodbye5(s);
    await sendGoMenu(from);
    await saveSession(from, s);
    return;
  }

  if (actionId === "pay_cash") {
    const out = await tools.procesar_pago(from, "cash");
    if (out.staffAlert?.to && out.staffAlert?.text) { try { await sendText(out.staffAlert.to, out.staffAlert.text); } catch {} }
    await sendText(from, out.customerText);
    setGoodbye5(s);
    await sendGoMenu(from);
    await saveSession(from, s);
    return;
  }

  // Text states
  if (text) {
    const t = text.trim().toLowerCase();

    // Atajos
    if (t === "ordenar") { await askOrderMode(from, s); await saveSession(from, s); return; }
    if (t === "menu" || t === "menú") { await showMainMenu(from, s); await saveSession(from, s); return; }

    if (s.state === "ASK_MESA") {
      const mesa = tryParseMesa(text);
      if (!mesa) { await sendText(from, "No pude entender la mesa. Ejemplo: ‘Mesa 4’"); await sendGoMenu(from); await saveSession(from, s); return; }
      s.mesa = mesa;
      await tools.asegurar_orden_abierta(from, mesa);
      s.state = "ORDERING";
      await sendText(from, "Perfecto. Ahora dime tu pedido (ej: '2 Choripán Clásico y 1 Agua Natural').");
      await sendGoMenu(from);
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
        if (!out.ok) {
          await sendText(from, "Formato inválido. Ej: ABCD001122XXX, correo@dominio.com");
          await sendGoMenu(from);
          await saveSession(from, s);
          return;
        }
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
      if (t !== "no" && t !== "nop" && t !== "n") {
        await tools.guardar_rating(from, s.lastRating || 5, text.trim());
      }
      s.state = "MAIN_MENU";
      await sendText(from, "¡Gracias! 🙌");
      await sendGoMenu(from);
      await saveSession(from, s);
      return;
    }

    // ORDERING (IA)
    if (s.state === "ORDERING") {
      if (!s.mesa) { await askMesa(from, s); await saveSession(from, s); return; }

      const system = `
Eres un POS conversacional de La Casita del Choripán.
REGLAS:
- NUNCA envíes a cocina (solo botón "✅ Enviar a cocina").
- Solo productos disponibles (consultar_menu).
- split_mode="${s.split_mode}": si split, cada item debe traer consumidor; si no, consumidor="General".
TAREA:
- Agregar items => previsualizar_pedido({telefono:"${from}", numero_mesa:${s.mesa}, items:[...]})
- Quitar => cancelar_item_sin_enviar({telefono:"${from}", producto:"..."})
Si dudas del nombre exacto, consulta el menú.
`.trim();

      const messages = [{ role: "system", content: system }, ...s.history, { role: "user", content: text }];
      const newMsgs = await runToolCalling(messages);

      pushHistory(s, "user", text);

      const lastPreview = getLastToolOutput(newMsgs, "previsualizar_pedido");
      if (lastPreview) {
        if (lastPreview.ok === false && lastPreview.error === "PRODUCTOS_NO_DISPONIBLES") {
          let msg = `❌ No disponibles / no encontrados:\n- ${lastPreview.missing.join("\n- ")}\n`;
          if (lastPreview.alternativas?.length) {
            msg += `\n✅ Alternativas:\n` + lastPreview.alternativas.slice(0, 6).map(a => `• ${a.nombre} — $${Number(a.precio).toFixed(2)}`).join("\n");
          }
          await sendText(from, msg.trim());
          await sendGoMenu(from);
          await saveSession(from, s);
          return;
        }
        if (lastPreview.ok === true) {
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

      await sendText(from, "Ok. Dime tu pedido con producto y cantidad (ej: '2 Choripán Clásico').");
      await sendGoMenu(from);
      await saveSession(from, s);
      return;
    }

    // Default
    await showMainMenu(from, s);
    await saveSession(from, s);
    return;
  }

  await sendText(from, "No pude leer tu mensaje. Intenta de nuevo.");
  await sendGoMenu(from);
  await saveSession(from, s);
}

// -------------------- Start --------------------
app.listen(PORT, () => console.log(`✅ Server running on http://localhost:${PORT}`));
