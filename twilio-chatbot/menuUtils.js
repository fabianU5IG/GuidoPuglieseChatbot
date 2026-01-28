/**
 * Helpers para identificar respuestas "tipo menú" y convertirlas a botones/listas.
 */

function normalizeLabel(s) {
  return String(s || "")
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "") // quita tildes
    .replace(/\s+/g, " ");
}

// Mapas para traducir selección por texto a número (cuando no llega ButtonPayload)
const MAIN_MENU_MAP = {
  [normalizeLabel("Agendar cita")]: "1",
  [normalizeLabel("Reprogramar cita")]: "2",
  [normalizeLabel("Cancelar cita")]: "3",
  [normalizeLabel("Información")]: "4",
  [normalizeLabel("Hablar con secretaría")]: "5",
};

const INFO_MENU_MAP = {
  [normalizeLabel("Ubicación")]: "1",
  [normalizeLabel("Modalidades (presencial / en línea)")]: "2",
  [normalizeLabel("Servicios")]: "3",
  [normalizeLabel("Seguros y pagos")]: "4",
  [normalizeLabel("Preparación para la consulta")]: "5",
  [normalizeLabel("Volver al menú")]: "6",
};

// Detectores (ligeros) para no depender de estado interno
function isMainMenuText(responseText) {
  const t = String(responseText || "");
  return (
    t.includes("Soy el asistente del consultorio del Dr. Guido Pugliese") &&
    t.includes("¿En qué te puedo ayudar?")
  );
}

function isInfoMenuText(responseText) {
  const t = String(responseText || "");
  return t.includes("¿Qué información necesitas?") || t.includes("¿Que información necesitas?");
}

/**
 * Extrae opciones tipo:
 * 1️⃣ Texto
 * 2️⃣ Texto
 * o:
 * 1. Texto
 * 2) Texto
 */
function extractOptions(text) {
  const lines = String(text || "").split(/\r?\n/);

  const optionRegexes = [
    /^\s*(\d{1,2})\s*️⃣\s*(.+)\s*$/u,                      // 1️⃣ Opción
    /^\s*(\d{1,2})\s*\uFE0F?\u20E3\s*(.+)\s*$/u,            // 1️⃣ en secuencia alternativa
    /^\s*(\d{1,2})\s*[\.\)\-:]\s*(.+)\s*$/u,                // 1. Opción / 1) Opción
  ];

  const options = [];
  for (const line of lines) {
    let matched = null;
    for (const re of optionRegexes) {
      const m = line.match(re);
      if (m) {
        matched = { id: parseInt(m[1], 10), label: (m[2] || "").trim(), raw: line };
        break;
      }
    }
    if (matched && !Number.isNaN(matched.id) && matched.label) {
      options.push({ id: matched.id, label: matched.label, raw: matched.raw });
    }
  }

  // Valida que sean secuenciales desde 1 (1..N)
  if (options.length < 2) return null;
  const ids = options.map((o) => o.id).sort((a, b) => a - b);

  for (let i = 0; i < ids.length; i++) {
    if (ids[i] !== i + 1) return null;
  }

  // Ordena por id
  options.sort((a, b) => a.id - b.id);
  return options;
}

function removeOptionLines(text, optionLinesSet) {
  const lines = String(text || "").split(/\r?\n/);
  const filtered = lines.filter((l) => !optionLinesSet.has(l));
  return filtered.join("\n").trim();
}

/**
 * Solo convertimos a "confirmación con botones" si el mensaje parece una confirmación.
 * (Evita convertir otros menús internos a botones sin templates adicionales)
 */
function parseConfirmMenu(responseText) {
  const t = String(responseText || "");
  const lower = normalizeLabel(t);

  // Heurística: confirmación
  const looksLikeConfirm =
    lower.includes("confirmas") || lower.includes("confirma") || lower.includes("confirmar");

  if (!looksLikeConfirm) return null;

  const options = extractOptions(t);
  if (!options) return null;
  if (options.length < 2 || options.length > 3) return null;

  const optionLines = new Set(options.map((o) => o.raw));
  const body = removeOptionLines(t, optionLines);

  // WhatsApp permite 1024 chars en body de quick reply (según docs de content type),
  // pero aquí dejamos un margen.
  const safeBody = body.length > 900 ? body.slice(0, 900) + "…" : body;

  // Limita títulos a 20 chars (regla típica de WhatsApp quick reply)
  const safeOptions = options.map((o) => ({
    id: o.id,
    label: o.label.length > 20 ? o.label.slice(0, 20) : o.label,
  }));

  return { body: safeBody, options: safeOptions };
}

module.exports = {
  normalizeLabel,
  isMainMenuText,
  isInfoMenuText,
  parseConfirmMenu,
  MAIN_MENU_MAP,
  INFO_MENU_MAP,
};
