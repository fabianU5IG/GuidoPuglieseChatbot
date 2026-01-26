/**
 * Chatbot Dr. Guido Pugliese — Doctoralia CO (sin API)
 * - Permite elegir FECHA específica (no Lunes–Viernes).
 * - Incluye deep link a Doctoralia (start booking).
 * - Maneja guía de OTP (recibió / reintentar / validar número).
 * - Captura URL final/IDs reales si el usuario pega el link.
 */

const DOCTORALIA_PROFILE_URL =
  "https://www.doctoralia.co/guido-pugliese-casalins/ortopedista-y-traumatologo/puerto-colombia";

const DOCTOR_ID = "6782";
const ADDRESS_ID = "85956";

// Deep link “start booking” (no requiere slotId)
const DOCTORALIA_BOOKING_START_URL = `https://www.doctoralia.co/booking/haga-una-cita/${DOCTOR_ID}/${ADDRESS_ID}`;

function normalizeText(s = "") {
  return String(s)
    .toLowerCase()
    .trim()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

function isEmergency(msg) {
  const m = normalizeText(msg);
  const triggers = [
    "urgencia",
    "emergencia",
    "fractura",
    "sangrado",
    "dolor fuerte",
    "no puedo caminar",
    "accidente",
    "trauma",
    "me desmayo",
    "perdi el conocimiento",
    "hemorragia",
  ];
  return triggers.some((t) => m.includes(t));
}

function isMenuIntent(msg) {
  const m = normalizeText(msg);
  return [
    "menu",
    "menú",
    "inicio",
    "volver",
    "volver al menu",
    "volver al menú",
  ].includes(m);
}

function isValidEmail(email) {
  const e = String(email || "").trim();
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e);
}

function normalizePhone(phone) {
  const raw = String(phone || "").trim();
  return raw.replace(/[^\d+]/g, "");
}

function generateTicketId() {
  // id simple para trazabilidad (puedes reemplazar por UUID/DB)
  const rand = Math.random().toString(16).slice(2, 8).toUpperCase();
  return `GP-${Date.now()}-${rand}`;
}

function getTimeSlots() {
  // Preferencias (NO disponibilidad real)
  return [
    "08:00",
    "08:20",
    "08:40",
    "09:00",
    "09:20",
    "09:40",
    "10:00",
    "10:20",
    "10:40",
    "11:00",
    "11:20",
    "11:40",
    "14:00",
    "14:20",
    "14:40",
    "15:00",
    "15:20",
    "15:40",
    "16:00",
    "16:20",
    "16:40",
  ];
}

function buildMainMenu() {
  return (
    "Soy el asistente del consultorio del Dr. Guido Pugliese.\n\n" +
    "¿En qué te puedo ayudar?\n\n" +
    "1️⃣ Agendar cita\n" +
    "2️⃣ Reprogramar cita\n" +
    "3️⃣ Cancelar cita\n" +
    "4️⃣ Información\n" +
    "5️⃣ Hablar con secretaría"
  );
}

function buildInfoMenu() {
  return (
    "¿Qué información necesitas?\n\n" +
    "1️⃣ Ubicación\n" +
    "2️⃣ Modalidades (presencial / en línea)\n" +
    "3️⃣ Servicios\n" +
    "4️⃣ Seguros y pagos\n" +
    "5️⃣ Preparación para la consulta\n" +
    "6️⃣ Volver al menú"
  );
}

function buildAddressConfirm() {
  return (
    "Perfecto. La sede es:\n" +
    "📍 Carrera 30 #1 - 850 Porto Azul consultorio 503, Puerto Colombia.\n\n" +
    "¿Confirmas que te queda bien?\n\n" +
    "1️⃣ Sí, me queda bien\n" +
    "2️⃣ Quiero hablar con secretaría"
  );
}

/**
 * Fecha: menú de próximos N días
 */
function addDays(d, n) {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}

function pad2(n) {
  return String(n).padStart(2, "0");
}

function formatDateISO(d) {
  // YYYY-MM-DD
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function formatDateHumanES(d) {
  const months = [
    "enero",
    "febrero",
    "marzo",
    "abril",
    "mayo",
    "junio",
    "julio",
    "agosto",
    "septiembre",
    "octubre",
    "noviembre",
    "diciembre",
  ];
  return `${pad2(d.getDate())} ${months[d.getMonth()]} ${d.getFullYear()}`;
}

function buildDateMenu(daysAhead = 14) {
  const today = new Date();
  const lines = [];
  for (let i = 0; i < Math.min(daysAhead, 14); i++) {
    const d = addDays(today, i);
    lines.push(`${i + 1}️⃣ ${formatDateHumanES(d)} (${formatDateISO(d)})`);
  }
  return (
    "Elige la fecha específica para tu cita:\n\n" +
    lines.join("\n") +
    "\n\nTambién puedes escribir la fecha en formato YYYY-MM-DD (ej: 2026-01-15) o DD/MM (ej: 15/01)."
  );
}

/**
 * Parseo de fecha desde texto:
 * - Opción 1: YYYY-MM-DD
 * - Opción 2: DD/MM o DD-MM
 * - Opción 3: "15 enero" / "15 de enero"
 */
function parseDateFromText(input) {
  const raw = String(input || "").trim();
  const m = normalizeText(raw);

  // YYYY-MM-DD
  let r = m.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (r) {
    const y = Number(r[1]),
      mo = Number(r[2]),
      d = Number(r[3]);
    const dt = new Date(y, mo - 1, d);
    if (
      dt &&
      dt.getFullYear() === y &&
      dt.getMonth() === mo - 1 &&
      dt.getDate() === d
    )
      return dt;
  }

  // DD/MM o DD-MM (asume año actual si no se especifica)
  r = m.match(/^(\d{1,2})[\/-](\d{1,2})(?:[\/-](\d{4}))?$/);
  if (r) {
    const d = Number(r[1]),
      mo = Number(r[2]);
    const y = r[3] ? Number(r[3]) : new Date().getFullYear();
    const dt = new Date(y, mo - 1, d);
    if (
      dt &&
      dt.getFullYear() === y &&
      dt.getMonth() === mo - 1 &&
      dt.getDate() === d
    )
      return dt;
  }

  // "15 enero" / "15 de enero"
  const months = {
    enero: 1,
    febrero: 2,
    marzo: 3,
    abril: 4,
    mayo: 5,
    junio: 6,
    julio: 7,
    agosto: 8,
    septiembre: 9,
    setiembre: 9,
    octubre: 10,
    noviembre: 11,
    diciembre: 12,
  };
  r = m.match(
    /^(\d{1,2})\s*(de\s*)?(enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|setiembre|octubre|noviembre|diciembre)(\s*(de\s*)?(\d{4}))?$/
  );
  if (r) {
    const d = Number(r[1]);
    const mo = months[r[3]];
    const y = r[6] ? Number(r[6]) : new Date().getFullYear();
    const dt = new Date(y, mo - 1, d);
    if (
      dt &&
      dt.getFullYear() === y &&
      dt.getMonth() === mo - 1 &&
      dt.getDate() === d
    )
      return dt;
  }

  return null;
}

function isFutureDate(dt) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const x = new Date(dt);
  x.setHours(0, 0, 0, 0);
  return x >= today;
}

/**
 * Intenta extraer IDs reales si el usuario pega un URL de Doctoralia:
 * Ejemplo:
 * https://www.doctoralia.co/booking/haga-una-cita/6782/85956/2026-01-15T08:40:00-05:00/287224
 */
function parseDoctoraliaBookingUrl(url) {
  const u = String(url || "").trim();
  const re =
    /^https:\/\/www\.doctoralia\.co\/booking\/haga-una-cita\/(\d+)\/(\d+)\/(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2})\/(\d+)/;
  const m = u.match(re);
  if (!m) return null;
  return {
    doctorId: m[1],
    addressId: m[2],
    dateTimeWithTZ: m[3],
    slotId: m[4],
    url: u,
  };
}

function buildSlotsMenu(page = 0, pageSize = 6) {
  const slots = getTimeSlots();
  const start = page * pageSize;
  const slice = slots.slice(start, start + pageSize);
  const lines = slice.map((h, i) => `${i + 1}️⃣ ${h}`).join("\n");
  const hasMore = start + pageSize < slots.length;

  return (
    "Selecciona la hora *preferida* (20 min).\n" +
    "⚠️ Nota: la disponibilidad final se confirma en Doctoralia o por secretaría.\n\n" +
    lines +
    (hasMore ? "\n\n7️⃣ Ver más horas" : "") +
    "\n\nResponde con el número (o escribe la hora, ej: 08:20)."
  );
}

function buildDoctoraliaMethodMenu() {
  return (
    "¿Cómo prefieres agendar?\n\n" +
    "1️⃣ Abrir calendario real de Doctoralia (recomendado)\n" +
    "2️⃣ Elegir fecha aquí y luego abrir Doctoralia para confirmar\n" +
    "3️⃣ Enviar mis datos a secretaría para que lo gestione\n\n" +
    "Responde 1, 2 o 3."
  );
}

function buildDoctoraliaLinkMsg(data) {
  const dateHint = data?.fechaISO ? `\n📅 Fecha elegida: ${data.fechaISO}` : "";
  const timeHint = data?.hora ? `\n🕒 Hora preferida: ${data.hora}` : "";

  return (
    "Perfecto. Para ver la *agenda real* y escoger un horario disponible en Doctoralia:\n\n" +
    `🔗 Calendario Doctoralia: ${DOCTORALIA_BOOKING_START_URL}\n` +
    `🔗 Perfil Doctoralia: ${DOCTORALIA_PROFILE_URL}\n` +
    `${dateHint}${timeHint}\n\n` +
    "Cuando Doctoralia te pida el *código de 4 cifras* (OTP), es normal.\n" +
    "Avanza el proceso allá y luego vuelve aquí.\n\n" +
    "1️⃣ Ya me llegó el código\n" +
    "2️⃣ No me llegó / quiero reintentar\n" +
    "3️⃣ Ya confirmé la cita (terminé)\n" +
    "4️⃣ Hablar con secretaría"
  );
}

function buildOtpHelp(data) {
  const phone =
    data?.telefono && data.telefono !== "Mismo número WhatsApp"
      ? data.telefono
      : "tu número de WhatsApp";
  return (
    "Entendido. Para el código (OTP) de Doctoralia:\n\n" +
    `• Verifica que el número sea correcto (${phone}).\n` +
    "• En la pantalla de Doctoralia toca: *Enviar el mensaje otra vez*.\n" +
    "• Revisa SMS/WhatsApp y espera 2 minutos.\n\n" +
    "Si sigue sin llegar:\n" +
    "1) intenta con SMS (si Doctoralia lo ofrece),\n" +
    "2) revisa señal / modo avión,\n" +
    "3) o indícame y te paso con secretaría.\n\n" +
    "Responde:\n" +
    "1️⃣ Ya me llegó el código\n" +
    "2️⃣ Aún no llega\n" +
    "3️⃣ Hablar con secretaría"
  );
}

function buildResumen(data) {
  const parts = [];
  parts.push("📌 Resumen de tu solicitud:");
  parts.push(`Ticket: ${data.ticketId || "-"}`);
  parts.push(`Nombre: ${data.nombre || "-"}`);
  parts.push(`Primera vez: ${data.primeraVez || "-"}`);
  parts.push(`Modalidad: ${data.modalidad || "-"}`);
  if (data.modalidad === "Visita presencial") {
    parts.push("Sede: Porto Azul consultorio 503 (Puerto Colombia)");
  }
  parts.push(`Servicio: ${data.servicio || "-"}`);
  parts.push(`Pago/Seguro: ${data.tipoPago || "-"}`);
  if (data.tipoPago === "Seguro/EPS" && data.aseguradoraTxt) {
    parts.push(`Aseguradora/EPS: ${data.aseguradoraTxt}`);
  }
  if (data.fechaISO) parts.push(`Fecha: ${data.fechaISO}`);
  if (data.hora) parts.push(`Hora: ${data.hora}`);
  if (data.correo) parts.push(`Correo: ${data.correo}`);
  parts.push(`Contacto: ${data.telefono || "Mismo número de WhatsApp"}`);

  return (
    parts.join("\n") +
    "\n\n¿Confirmas?\n\n" +
    "1️⃣ Continuar\n" +
    "2️⃣ Cambiar datos\n" +
    "3️⃣ Hablar con secretaría"
  );
}

function buildEditarMenu() {
  return (
    "¿Qué deseas cambiar?\n\n" +
    "1️⃣ Modalidad\n" +
    "2️⃣ Servicio\n" +
    "3️⃣ Seguro / pago\n" +
    "4️⃣ Fecha\n" +
    "5️⃣ Hora\n" +
    "6️⃣ Contacto / correo\n" +
    "7️⃣ Volver al resumen"
  );
}

/* ======================
   CHATBOT
====================== */
function chatbotResponse(message, session) {
  let response = "";
  let nextState = session.state || "START";
  let data = session.data || {};
  const msgRaw = String(message || "");
  const msg = normalizeText(msgRaw);

  // Crear ticketId una sola vez por sesión
  if (!data.ticketId) data.ticketId = generateTicketId();

  // Menu global
  if (isMenuIntent(msgRaw)) {
    response = buildMainMenu();
    nextState = "MENU";
    return { response, nextState, data };
  }

  // Emergencias global
  if (isEmergency(msgRaw)) {
    response =
      "Entiendo. Si esto es una urgencia o presentas síntomas severos, por favor acude a un servicio de emergencias o llama a tu línea de urgencias.\n\n" +
      "Si deseas, también puedo pasar tu mensaje a secretaría.\n\n" +
      "1️⃣ Hablar con secretaría\n" +
      "2️⃣ Volver al menú";
    nextState = "EMERGENCIA_MENU";
    return { response, nextState, data };
  }

  if (nextState === "START") {
    response =
      "Para tu seguridad, no compartas información clínica sensible por WhatsApp.\n" +
      "Si es una urgencia, acude a servicios de emergencia.\n\n" +
      buildMainMenu();
    nextState = "MENU";
    return { response, nextState, data };
  }

  if (nextState === "EMERGENCIA_MENU") {
    if (msg === "1") {
      response =
        "Listo. Por favor escribe en una sola frase qué necesitas y tu nombre completo.";
      nextState = "SECRETARIA_MENSAJE";
    } else {
      response = buildMainMenu();
      nextState = "MENU";
    }
    return { response, nextState, data };
  }

  /* MENU */
  if (nextState === "MENU") {
    if (msg === "1") {
      response = "Perfecto. Para agendar, indícame tu nombre completo.";
      nextState = "AGENDAR_NOMBRE";
    } else if (msg === "2") {
      response =
        "Claro. Para reprogramar necesito ubicar tu cita.\n\n" +
        "1️⃣ Sí, la agendé por Doctoralia\n" +
        "2️⃣ No / No recuerdo\n" +
        "3️⃣ Hablar con secretaría";
      nextState = "REPRO_MENU";
    } else if (msg === "3") {
      response =
        "Entiendo. Para cancelar, por favor indícame:\n" +
        "1) Nombre y apellido\n" +
        "2) Fecha/hora de la cita (aprox.)\n\n" +
        "Escríbelo en un solo mensaje.";
      nextState = "CANCELAR_DATOS";
    } else if (msg === "4") {
      response = buildInfoMenu();
      nextState = "INFO_MENU";
    } else if (msg === "5") {
      response =
        "Claro. Por favor escribe tu solicitud para secretaría (en una sola frase) y tu nombre completo.";
      nextState = "SECRETARIA_MENSAJE";
    } else {
      response = "Por favor elige una opción:\n\n" + buildMainMenu();
    }
    return { response, nextState, data };
  }

  /* INFO */
  if (nextState === "INFO_MENU") {
    if (msg === "1") {
      response =
        "📍 Ubicación: Carrera 30 #1 - 850 Porto Azul consultorio 503, Puerto Colombia.\n\n" +
        buildInfoMenu();
    } else if (msg === "2") {
      response =
        "Modalidades disponibles:\n" +
        "• Visita presencial\n" +
        "• Consulta en línea\n\n" +
        buildInfoMenu();
    } else if (msg === "3") {
      response =
        "Servicios:\n" +
        "1) Visita Ortopedia y Traumatología\n" +
        "2) Consulta de Ortopedia y Traumatología\n\n" +
        buildInfoMenu();
    } else if (msg === "4") {
      response =
        "Puedes agendar como Particular o por Seguro/EPS (dependiendo de disponibilidad).\n" +
        "Si me dices tu aseguradora/EPS, lo registramos para validar.\n\n" +
        buildInfoMenu();
    } else if (msg === "5") {
      response =
        "Recomendación general: lleva exámenes/imágenes previas (si tienes), lista de medicamentos y describe desde cuándo presentas el síntoma.\n\n" +
        buildInfoMenu();
    } else if (msg === "6") {
      response = buildMainMenu();
      nextState = "MENU";
      return { response, nextState, data };
    } else {
      response = "Elige una opción válida.\n\n" + buildInfoMenu();
    }
    return { response, nextState, data };
  }

  /* REPROGRAMAR */
  if (nextState === "REPRO_MENU") {
    if (msg === "1" || msg === "2") {
      data.reproOrigen = msg === "1" ? "Doctoralia" : "Otro/No recuerda";
      response =
        "Por favor envíame:\n" +
        "1) Nombre y apellido\n" +
        "2) Fecha/hora actual de la cita (aprox.)\n" +
        (data.reproOrigen === "Doctoralia"
          ? "3) Correo con el que agendaste (si aplica)\n"
          : "") +
        "\nEscríbelo en un solo mensaje.";
      nextState = "REPRO_DATOS";
      return { response, nextState, data };
    }
    if (msg === "3") {
      response =
        "Listo. Escribe tu solicitud para secretaría (en una sola frase) y tu nombre completo.";
      nextState = "SECRETARIA_MENSAJE";
      return { response, nextState, data };
    }
    response = "Elige 1, 2 o 3.";
    return { response, nextState, data };
  }

  if (nextState === "REPRO_DATOS") {
    data.reprogramarDatos = msgRaw;
    response =
      "Gracias. ¿Qué prefieres?\n\n" +
      "1️⃣ Enviarme opciones de nuevas horas\n" +
      "2️⃣ Enviar enlace para reprogramar en Doctoralia\n" +
      "3️⃣ Que lo gestione la secretaría";
    nextState = "REPRO_ACCION";
    return { response, nextState, data };
  }

  if (nextState === "REPRO_ACCION") {
    if (msg === "1") {
      response =
        "Perfecto. Dime por favor:\n" +
        "• ¿Presencial o en línea?\n" +
        "• Fecha preferida (YYYY-MM-DD)\n\n" +
        "Ejemplo: 'Presencial, 2026-01-15'";
      nextState = "REPRO_PREFERENCIAS";
    } else if (msg === "2") {
      response =
        "Te comparto el enlace para reprogramar en Doctoralia:\n\n" +
        `🔗 ${DOCTORALIA_PROFILE_URL}\n\n` +
        "Cuando termines, responde 'LISTO' y lo registramos.";
      nextState = "REPRO_LISTO";
    } else if (msg === "3") {
      response =
        "Listo. Ya envié la solicitud a secretaría para que gestionen la reprogramación. Te confirmarán en el próximo horario hábil.";
      nextState = "CERRADO";
    } else {
      response = "Elige 1, 2 o 3.";
    }
    return { response, nextState, data };
  }

  if (nextState === "REPRO_PREFERENCIAS") {
    data.reproPreferencias = msgRaw;
    response =
      "Perfecto. Ya envié tus preferencias a secretaría. Te confirmarán en el próximo horario hábil.";
    nextState = "CERRADO";
    return { response, nextState, data };
  }

  if (nextState === "REPRO_LISTO") {
    if (msg.includes("listo")) {
      response =
        "Gracias. Quedó registrado. Si necesitas apoyo adicional, escribe 'Secretaría' o vuelve al menú.\n\n" +
        buildMainMenu();
      nextState = "MENU";
    } else {
      response = "Cuando hayas finalizado, responde 'LISTO'.";
    }
    return { response, nextState, data };
  }

  /* CANCELAR */
  if (nextState === "CANCELAR_DATOS") {
    data.cancelarDatos = msgRaw;
    response =
      "¿Confirmas que deseas cancelar la cita?\n\n" +
      "1️⃣ Sí, cancelar\n" +
      "2️⃣ No\n" +
      "3️⃣ Hablar con secretaría";
    nextState = "CANCELAR_CONFIRMAR";
    return { response, nextState, data };
  }

  if (nextState === "CANCELAR_CONFIRMAR") {
    if (msg === "1") {
      response =
        "Listo, registré la solicitud de cancelación y la envié a secretaría.\n\n" +
        buildMainMenu();
      nextState = "MENU";
    } else if (msg === "2") {
      response = "Perfecto. No realizo la cancelación.\n\n" + buildMainMenu();
      nextState = "MENU";
    } else if (msg === "3") {
      response =
        "Claro. Escribe tu solicitud para secretaría (en una sola frase) y tu nombre completo.";
      nextState = "SECRETARIA_MENSAJE";
    } else {
      response = "Elige 1, 2 o 3.";
    }
    return { response, nextState, data };
  }

  /* SECRETARÍA */
  if (nextState === "SECRETARIA_MENSAJE") {
    data.mensajeSecretaria = msgRaw;
    response =
      "Gracias. Ya registré tu mensaje para secretaría.\n" +
      "Te responderán en el próximo horario hábil.\n\n" +
      buildMainMenu();
    nextState = "MENU";
    return { response, nextState, data };
  }

  /* AGENDAR */
  if (nextState === "AGENDAR_NOMBRE") {
    data.nombre = msgRaw.trim();
    response =
      `Gracias, ${data.nombre}.\n\n` +
      "¿Es tu primera vez con el especialista?\n\n" +
      "1️⃣ Sí\n" +
      "2️⃣ No";
    nextState = "AGENDAR_PRIMERA_VEZ";
    return { response, nextState, data };
  }

  if (nextState === "AGENDAR_PRIMERA_VEZ") {
    if (msg === "1") data.primeraVez = "Sí";
    else if (msg === "2") data.primeraVez = "No";
    else {
      response = "Elige 1️⃣ o 2️⃣.";
      return { response, nextState, data };
    }

    response =
      "¿Cómo deseas tu cita?\n\n" +
      "1️⃣ Visita presencial\n" +
      "2️⃣ Consulta en línea";
    nextState = "AGENDAR_MODALIDAD";
    return { response, nextState, data };
  }

  if (nextState === "AGENDAR_MODALIDAD") {
    if (msg === "1") data.modalidad = "Visita presencial";
    else if (msg === "2") data.modalidad = "Consulta en línea";
    else {
      response = "Elige 1️⃣ o 2️⃣.";
      return { response, nextState, data };
    }

    if (data.modalidad === "Visita presencial") {
      response = buildAddressConfirm();
      nextState = "AGENDAR_DIRECCION_CONFIRMAR";
      return { response, nextState, data };
    }

    response =
      "Selecciona el servicio:\n\n" +
      "1️⃣ Visita Ortopedia y Traumatología\n" +
      "2️⃣ Consulta de Ortopedia y Traumatología";
    nextState = "AGENDAR_SERVICIO";
    return { response, nextState, data };
  }

  if (nextState === "AGENDAR_DIRECCION_CONFIRMAR") {
    if (msg === "1") {
      response =
        "Selecciona el servicio:\n\n" +
        "1️⃣ Visita Ortopedia y Traumatología\n" +
        "2️⃣ Consulta de Ortopedia y Traumatología";
      nextState = "AGENDAR_SERVICIO";
      return { response, nextState, data };
    }
    if (msg === "2") {
      response =
        "Claro. Escribe tu solicitud para secretaría (en una sola frase) y tu nombre completo.";
      nextState = "SECRETARIA_MENSAJE";
      return { response, nextState, data };
    }
    response = "Elige 1️⃣ o 2️⃣.";
    return { response, nextState, data };
  }

  if (nextState === "AGENDAR_SERVICIO") {
    const servicios = {
      1: "Visita Ortopedia y Traumatología",
      2: "Consulta de Ortopedia y Traumatología",
    };

    if (!servicios[msg]) {
      response = "Selecciona una opción válida (1 o 2).";
      return { response, nextState, data };
    }

    data.servicio = servicios[msg];

    response =
      "¿Vienes por seguro/EPS o particular?\n\n" +
      "1️⃣ Seguro/EPS\n" +
      "2️⃣ Particular\n" +
      "3️⃣ No estoy seguro/a";
    nextState = "AGENDAR_TIPO_PAGO";
    return { response, nextState, data };
  }

  if (nextState === "AGENDAR_TIPO_PAGO") {
    if (msg === "1") {
      data.tipoPago = "Seguro/EPS";
      response =
        "Perfecto. ¿Cuál es tu aseguradora/EPS? (Escríbela tal cual aparece)";
      nextState = "AGENDAR_ASEGURADORA_TEXTO";
      return { response, nextState, data };
    }
    if (msg === "2") {
      data.tipoPago = "Particular";
      response = buildDoctoraliaMethodMenu();
      nextState = "AGENDAR_METODO";
      return { response, nextState, data };
    }
    if (msg === "3") {
      data.tipoPago = "No está seguro/a";
      response = buildDoctoraliaMethodMenu();
      nextState = "AGENDAR_METODO";
      return { response, nextState, data };
    }

    response = "Elige 1️⃣, 2️⃣ o 3️⃣.";
    return { response, nextState, data };
  }

  if (nextState === "AGENDAR_ASEGURADORA_TEXTO") {
    data.aseguradoraTxt = msgRaw.trim();
    response = buildDoctoraliaMethodMenu();
    nextState = "AGENDAR_METODO";
    return { response, nextState, data };
  }

  // Método de agendamiento
  if (nextState === "AGENDAR_METODO") {
    if (msg === "1") {
      data.metodoAgendamiento = "DoctoraliaDirecto";
      response =
        "Listo. Antes de enviarte el link, ¿este WhatsApp es tu número de contacto?\n\n" +
        "1️⃣ Sí\n" +
        "2️⃣ No";
      nextState = "AGENDAR_CONTACTO";
      return { response, nextState, data };
    }

    if (msg === "2") {
      data.metodoAgendamiento = "DoctoraliaGuiado";
      response = buildDateMenu(14);
      nextState = "AGENDAR_FECHA";
      return { response, nextState, data };
    }

    if (msg === "3") {
      data.metodoAgendamiento = "Secretaria";
      response = buildResumen(data);
      nextState = "RESUMEN_CONFIRMAR";
      return { response, nextState, data };
    }

    response = "Elige 1, 2 o 3.\n\n" + buildDoctoraliaMethodMenu();
    return { response, nextState, data };
  }

  // Fecha específica (modo guiado)
  if (nextState === "AGENDAR_FECHA") {
    // Selección por número del menú 1..14
    const idx = parseInt(msg, 10);
    if (!isNaN(idx) && idx >= 1 && idx <= 14) {
      const dt = addDays(new Date(), idx - 1);
      data.fechaISO = formatDateISO(dt);
      response = buildSlotsMenu(0);
      data.slotPage = 0;
      nextState = "AGENDAR_HORA";
      return { response, nextState, data };
    }

    // Selección por texto
    const dt = parseDateFromText(msgRaw);
    if (!dt || !isFutureDate(dt)) {
      response =
        "No pude interpretar la fecha. Por favor:\n" +
        "• elige un número del menú (1–14), o\n" +
        "• escribe YYYY-MM-DD (ej: 2026-01-15), o\n" +
        "• DD/MM (ej: 15/01).";
      return { response, nextState, data };
    }

    data.fechaISO = formatDateISO(dt);
    response = buildSlotsMenu(0);
    data.slotPage = 0;
    nextState = "AGENDAR_HORA";
    return { response, nextState, data };
  }

  // Hora preferida (modo guiado)
  if (nextState === "AGENDAR_HORA") {
    const slots = getTimeSlots();

    if (msg === "7" && (data.slotPage || 0) * 6 + 6 < slots.length) {
      data.slotPage = (data.slotPage || 0) + 1;
      response = buildSlotsMenu(data.slotPage);
      return { response, nextState, data };
    }

    const hourDirect = msgRaw.trim();
    if (/^\d{2}:\d{2}$/.test(hourDirect) && slots.includes(hourDirect)) {
      data.hora = hourDirect;
    } else {
      const page = data.slotPage || 0;
      const baseIndex = page * 6;
      const index = parseInt(msg, 10) - 1;

      if (isNaN(index) || index < 0 || index > 5) {
        response =
          "Selecciona un número válido (1–6), 7 para ver más (si aplica), o escribe la hora (ej: 08:20).";
        return { response, nextState, data };
      }

      const chosen = slots[baseIndex + index];
      if (!chosen) {
        response =
          "Esa hora no es válida. Elige otra o escribe una hora válida (ej: 08:20).";
        return { response, nextState, data };
      }
      data.hora = chosen;
    }

    // Si primera vez, pedir correo
    if (data.primeraVez === "Sí" && !data.correo) {
      response =
        "Gracias. Como es tu primera vez, ¿me compartes tu correo para enviarte recomendaciones previas a la cita?";
      nextState = "AGENDAR_CORREO";
      return { response, nextState, data };
    }

    response =
      "Para continuar, ¿este WhatsApp es tu número de contacto?\n\n" +
      "1️⃣ Sí\n" +
      "2️⃣ No";
    nextState = "AGENDAR_CONTACTO";
    return { response, nextState, data };
  }

  if (nextState === "AGENDAR_CORREO") {
    const email = msgRaw.trim();
    if (!isValidEmail(email)) {
      response = "Por favor escribe un correo válido (ej: nombre@correo.com).";
      return { response, nextState, data };
    }
    data.correo = email;

    response =
      "Para continuar, ¿este WhatsApp es tu número de contacto?\n\n" +
      "1️⃣ Sí\n" +
      "2️⃣ No";
    nextState = "AGENDAR_CONTACTO";
    return { response, nextState, data };
  }

  if (nextState === "AGENDAR_CONTACTO") {
    if (msg === "1") {
      data.telefono = "Mismo número WhatsApp";
      response = buildResumen(data);
      nextState = "RESUMEN_CONFIRMAR";
      return { response, nextState, data };
    }
    if (msg === "2") {
      response =
        "Indícame el número de contacto (ej: +573001112233 o 3001112233).";
      nextState = "AGENDAR_TELEFONO";
      return { response, nextState, data };
    }
    response = "Elige 1️⃣ o 2️⃣.";
    return { response, nextState, data };
  }

  if (nextState === "AGENDAR_TELEFONO") {
    data.telefono = normalizePhone(msgRaw);
    response = buildResumen(data);
    nextState = "RESUMEN_CONFIRMAR";
    return { response, nextState, data };
  }

  // Confirmación del resumen
  if (nextState === "RESUMEN_CONFIRMAR") {
    if (msg === "1") {
      // Si método Doctoralia (directo o guiado): enviamos el link + OTP flow
      if (
        data.metodoAgendamiento === "DoctoraliaDirecto" ||
        data.metodoAgendamiento === "DoctoraliaGuiado"
      ) {
        // Inicializa estructura doctoralia en sesión
        data.doctoralia = data.doctoralia || {};
        data.doctoralia.doctorId = DOCTOR_ID;
        data.doctoralia.addressId = ADDRESS_ID;
        data.doctoralia.status = "LINK_SENT";

        response = buildDoctoraliaLinkMsg(data);
        nextState = "DOCTORALIA_OTP_FLOW";
        return { response, nextState, data };
      }

      // Método Secretaría
      response =
        "Perfecto. Ya tengo tu solicitud y la envié a secretaría.\n" +
        "Te contactarán en el próximo horario hábil.\n\n" +
        buildMainMenu();
      nextState = "MENU";
      return { response, nextState, data };
    }

    if (msg === "2") {
      response = buildEditarMenu();
      nextState = "EDITAR_MENU";
      return { response, nextState, data };
    }

    if (msg === "3") {
      response =
        "Claro. Escribe tu solicitud para secretaría (en una sola frase) y tu nombre completo.";
      nextState = "SECRETARIA_MENSAJE";
      return { response, nextState, data };
    }

    response = "Elige 1️⃣, 2️⃣ o 3️⃣.\n\n" + buildResumen(data);
    return { response, nextState, data };
  }

  /**
   * Flujo OTP Doctoralia:
   * 1) Ya me llegó el código
   * 2) No me llegó / reintentar
   * 3) Ya confirmé la cita
   * 4) Secretaría
   *
   * Además: si el usuario pega un URL final de Doctoralia, capturamos IDs reales.
   */
  if (nextState === "DOCTORALIA_OTP_FLOW") {
    // Si pegó URL de Doctoralia, capturamos IDs reales
    const parsed = parseDoctoraliaBookingUrl(msgRaw);
    if (parsed) {
      data.doctoralia = data.doctoralia || {};
      data.doctoralia.doctorId = parsed.doctorId;
      data.doctoralia.addressId = parsed.addressId;
      data.doctoralia.slotId = parsed.slotId;
      data.doctoralia.dateTimeWithTZ = parsed.dateTimeWithTZ;
      data.doctoralia.url = parsed.url;
      data.doctoralia.status = "URL_CAPTURED";

      response =
        "Perfecto, ya registré los datos de tu cita desde Doctoralia.\n\n" +
        "Ahora dime:\n" +
        "1️⃣ Ya confirmé la cita (terminé)\n" +
        "2️⃣ Aún estoy en el paso del código (OTP)\n" +
        "3️⃣ Hablar con secretaría";
      return { response, nextState, data };
    }

    if (msg === "1") {
      data.doctoralia = data.doctoralia || {};
      data.doctoralia.status = "OTP_RECEIVED";
      response =
        "Excelente. Ingresa el código en Doctoralia y finaliza la confirmación.\n\n" +
        "Cuando termines, responde:\n" +
        "1️⃣ Ya confirmé la cita (terminé)\n" +
        "2️⃣ No pude confirmar\n" +
        "3️⃣ Hablar con secretaría\n\n" +
        "Tip: si Doctoralia muestra un enlace final o confirmación, puedes pegarlo aquí para registrarlo.";
      nextState = "DOCTORALIA_OTP_DONE_CHECK";
      return { response, nextState, data };
    }

    if (msg === "2") {
      data.doctoralia = data.doctoralia || {};
      data.doctoralia.status = "OTP_NOT_RECEIVED";
      response = buildOtpHelp(data);
      nextState = "DOCTORALIA_OTP_HELP";
      return { response, nextState, data };
    }

    if (msg === "3") {
      data.doctoralia = data.doctoralia || {};
      data.doctoralia.status = "CONFIRMED_BY_PATIENT";
      response =
        "Gracias. Quedó registrado que confirmaste la cita en Doctoralia.\n\n" +
        "Si deseas, pega aquí el enlace final de confirmación para dejarlo en el registro.\n" +
        "Si no lo tienes, no hay problema.\n\n" +
        buildMainMenu();
      nextState = "MENU";
      return { response, nextState, data };
    }

    if (msg === "4") {
      response =
        "Claro. Escribe tu solicitud para secretaría (en una sola frase) y tu nombre completo.";
      nextState = "SECRETARIA_MENSAJE";
      return { response, nextState, data };
    }

    response = "Responde con 1, 2, 3 o 4.\n\n" + buildDoctoraliaLinkMsg(data);
    return { response, nextState, data };
  }

  if (nextState === "DOCTORALIA_OTP_HELP") {
    if (msg === "1") {
      response =
        "Excelente. Ingresa el código en Doctoralia y finaliza.\n\n" +
        "Cuando termines responde:\n" +
        "1️⃣ Ya confirmé la cita (terminé)\n" +
        "2️⃣ No pude confirmar\n" +
        "3️⃣ Hablar con secretaría";
      nextState = "DOCTORALIA_OTP_DONE_CHECK";
      return { response, nextState, data };
    }
    if (msg === "2") {
      response = buildOtpHelp(data);
      return { response, nextState, data };
    }
    if (msg === "3") {
      response =
        "Claro. Escribe tu solicitud para secretaría (en una sola frase) y tu nombre completo.";
      nextState = "SECRETARIA_MENSAJE";
      return { response, nextState, data };
    }
    response = "Elige 1, 2 o 3.\n\n" + buildOtpHelp(data);
    return { response, nextState, data };
  }

  if (nextState === "DOCTORALIA_OTP_DONE_CHECK") {
    if (msg === "1") {
      data.doctoralia = data.doctoralia || {};
      data.doctoralia.status = "CONFIRMED_BY_PATIENT";
      response =
        "Perfecto. Quedó registrado que confirmaste tu cita en Doctoralia.\n\n" +
        "Si tienes el enlace final de confirmación, pégalo aquí para registrar los IDs.\n" +
        "Si no, escribe 'MENÚ' para finalizar.";
      nextState = "DOCTORALIA_OTP_FLOW"; // volvemos para permitir pegar URL
      return { response, nextState, data };
    }
    if (msg === "2") {
      response =
        "Entiendo. Puedes intentar de nuevo en Doctoralia usando el link:\n\n" +
        `🔗 ${DOCTORALIA_BOOKING_START_URL}\n\n` +
        "Si prefieres, te paso con secretaría.\n\n" +
        "1️⃣ Reintentar\n" +
        "2️⃣ Hablar con secretaría\n" +
        "3️⃣ Menú";
      nextState = "DOCTORALIA_CANNOT_CONFIRM";
      return { response, nextState, data };
    }
    if (msg === "3") {
      response =
        "Claro. Escribe tu solicitud para secretaría (en una sola frase) y tu nombre completo.";
      nextState = "SECRETARIA_MENSAJE";
      return { response, nextState, data };
    }
    response = "Elige 1, 2 o 3.";
    return { response, nextState, data };
  }

  if (nextState === "DOCTORALIA_CANNOT_CONFIRM") {
    if (msg === "1") {
      response = buildDoctoraliaLinkMsg(data);
      nextState = "DOCTORALIA_OTP_FLOW";
      return { response, nextState, data };
    }
    if (msg === "2") {
      response =
        "Claro. Escribe tu solicitud para secretaría (en una sola frase) y tu nombre completo.";
      nextState = "SECRETARIA_MENSAJE";
      return { response, nextState, data };
    }
    response = buildMainMenu();
    nextState = "MENU";
    return { response, nextState, data };
  }

  /* EDITAR */
  if (nextState === "EDITAR_MENU") {
    if (msg === "1") {
      response =
        "¿Cómo deseas tu cita?\n\n" +
        "1️⃣ Visita presencial\n" +
        "2️⃣ Consulta en línea";
      nextState = "AGENDAR_MODALIDAD";
      return { response, nextState, data };
    }
    if (msg === "2") {
      response =
        "Selecciona el servicio:\n\n" +
        "1️⃣ Visita Ortopedia y Traumatología\n" +
        "2️⃣ Consulta de Ortopedia y Traumatología";
      nextState = "AGENDAR_SERVICIO";
      return { response, nextState, data };
    }
    if (msg === "3") {
      response =
        "¿Vienes por seguro/EPS o particular?\n\n" +
        "1️⃣ Seguro/EPS\n" +
        "2️⃣ Particular\n" +
        "3️⃣ No estoy seguro/a";
      nextState = "AGENDAR_TIPO_PAGO";
      return { response, nextState, data };
    }
    if (msg === "4") {
      response = buildDateMenu(14);
      nextState = "AGENDAR_FECHA";
      return { response, nextState, data };
    }
    if (msg === "5") {
      data.slotPage = 0;
      response = buildSlotsMenu(0);
      nextState = "AGENDAR_HORA";
      return { response, nextState, data };
    }
    if (msg === "6") {
      response =
        "¿Qué deseas actualizar?\n\n" +
        "1️⃣ Correo\n" +
        "2️⃣ Número de contacto\n" +
        "3️⃣ Volver";
      nextState = "EDITAR_CONTACTO_MENU";
      return { response, nextState, data };
    }
    if (msg === "7") {
      response = buildResumen(data);
      nextState = "RESUMEN_CONFIRMAR";
      return { response, nextState, data };
    }

    response = "Elige una opción válida.\n\n" + buildEditarMenu();
    return { response, nextState, data };
  }

  if (nextState === "EDITAR_CONTACTO_MENU") {
    if (msg === "1") {
      response = "Escribe tu correo.";
      nextState = "EDITAR_CORREO";
      return { response, nextState, data };
    }
    if (msg === "2") {
      response = "Escribe tu número de contacto.";
      nextState = "EDITAR_TELEFONO";
      return { response, nextState, data };
    }
    if (msg === "3") {
      response = buildEditarMenu();
      nextState = "EDITAR_MENU";
      return { response, nextState, data };
    }
    response = "Elige 1, 2 o 3.";
    return { response, nextState, data };
  }

  if (nextState === "EDITAR_CORREO") {
    const email = msgRaw.trim();
    if (!isValidEmail(email)) {
      response = "Por favor escribe un correo válido (ej: nombre@correo.com).";
      return { response, nextState, data };
    }
    data.correo = email;
    response = buildResumen(data);
    nextState = "RESUMEN_CONFIRMAR";
    return { response, nextState, data };
  }

  if (nextState === "EDITAR_TELEFONO") {
    data.telefono = normalizePhone(msgRaw);
    response = buildResumen(data);
    nextState = "RESUMEN_CONFIRMAR";
    return { response, nextState, data };
  }

  /* FALLBACK */
  response =
    "Para ayudarte mejor, elige una opción del menú:\n\n" + buildMainMenu();
  nextState = "MENU";
  return { response, nextState, data };
}

module.exports = chatbotResponse;
