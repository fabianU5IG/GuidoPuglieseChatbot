import {
    createProposedAppointment,
    logAppointmentMessage,
    upsertPatientName,
    updateAppointmentStatusById,
} from "../services/chatbot-db.service.js";
import { createSaludtoolsJob } from "../services/saludtools-jobs.service.js";
import { EPS_CONVENIO, SALUDTOOLS } from "../constants.js";
import {
    classifyRegistrationInputAI,
    generateAppointmentPreparationTipsAI,
    normalizeAppointmentInputAI,
    recommendAppointmentOptionsAI,
} from "../services/azure.ai.services.js";
import { sendWhatsAppMessage } from "../services/whatsapp.service.js";
import { resolveFlowFallback } from "../services/flowFallback.service.js";
import { db } from "../db/mysql.js";
import {
    isHoliday,
    getScheduleBlocksForYmd,
} from "../services/doctor-schedule.service.js";

const DOCTOR_DOCUMENT_TYPE = Number(
    process.env.SALUDTOOLS_DOCTOR_DOCUMENT_TYPE || 1,
);
const DOCTOR_DOCUMENT_NUMBER =
    process.env.SALUDTOOLS_DOCTOR_DOCUMENT_NUMBER || "72134079";
const CLINIC_ID = Number(process.env.SALUDTOOLS_CLINIC_ID || 18569);

const APPOINTMENT_DURATION_MIN = Number(
    process.env.SALUDTOOLS_APPOINTMENT_DURATION_MIN ||
        SALUDTOOLS.APPOINTMENT_DURATION_MIN,
);
const APPOINTMENT_MODALITY =
    process.env.SALUDTOOLS_APPOINTMENT_MODALITY || "CONVENTIONAL";
const APPOINTMENT_STATE = process.env.SALUDTOOLS_APPOINTMENT_STATE || "PENDING";
const APPOINTMENT_TYPE_DEFAULT =
    process.env.SALUDTOOLS_APPOINTMENT_TYPE || "Pruebas Luis";

const SALUDTOOLS_DEBUG =
    String(process.env.SALUDTOOLS_DEBUG || "").toLowerCase() === "true" ||
    process.env.SALUDTOOLS_DEBUG === "1";

const AI_GLOBAL_SCHEDULING_ENABLED = !["false", "0", "off", "no"].includes(
    String(process.env.AI_GLOBAL_SCHEDULING_ENABLED || "true")
        .trim()
        .toLowerCase(),
);

const TEMPLATE_MENU_PRINCIPAL = "HX8a87673651f780a2781725fb23872427";
const TEMPLATE_ASK_DOC_NUMBER = "HX81850303bf6a4fb7807fe02bf293d497";
const TEMPLATE_ASK_ATTENTION_TYPE = "HX91e5d2cc86e00782a2ca350967eabf43";
const TEMPLATE_AVAILABLE_HOURS = "HX288f8c61244fb7ccd84dadc3a2b18085";

// Plantillas del flujo de registro de paciente nuevo (botones reales de WhatsApp).
// SIDs actualizados a la versión "copy_..." con el texto mejorado (agosto 2026).
const TEMPLATE_REG_CONFIRM_NAMES = "HXb82d4efe6c8e953e769007d97e1b7683";
const TEMPLATE_REG_DOCUMENT_NUMBER = "HX6870e9d8c2a707250a7b7b6dd3657bba";
const TEMPLATE_REG_FIRSTNAME = "HXef564c5e031c89c509865f9ad0cc2671";
const TEMPLATE_REG_SECONDNAME = "HXf0c0b5145ad2c66b0dc2ee6016edcb08";
const TEMPLATE_REG_BIRTHDATE = "HXd9b8fa306aa4c104781028d08cb2f5be";
const TEMPLATE_REG_GENDER = "HX2c7ba0ad6b58366a172c0cfb11098e0f";
const TEMPLATE_REG_EPS = "HXbb5aca08c0cdb066a18f498bb1008777";
const TEMPLATE_REG_PHONE = "HX4b3a4c4c8156d55b10784d96d65a8767";
const TEMPLATE_REG_EMAIL = "HX2c186ee128f8b00e3e76af2ca8ab19d2";
const TEMPLATE_REG_HABEAS = "HX606fb740ee66367afa3c387aa8c35e14";

// Plantillas nuevas: confirmación final de cita y cierre del flujo de agendamiento.
const TEMPLATE_CONFIRM_CITA = "HXcc96f44990e9c311650fe93e71b3b1bc";
const TEMPLATE_SOLICITUD_REGISTRADA = "HXf424f63c3ee61d734604063ecc214b10";

// Recomendación de fecha/hora de la IA, una plantilla por cantidad de opciones.
const TEMPLATE_RECOMENDACION_1 = "HX99f2473708d3a747691d12c7844376a6";
const TEMPLATE_RECOMENDACION_2 = "HX95ea998332a873f75d2b983698e71c4a";
const TEMPLATE_RECOMENDACION_3 = "HXd07499f9bf2d1fe24f69226be43a4026";

function sendTemplate(contentSid, nextState = "AGENDAR", data = {}, variables = null) {
    return {
        response: null,
        nextState,
        data,
        sendTemplate: true,
        template: {
            contentSid,
            variables,
        },
    };
}

function returnToMenu() {
    return sendTemplate(TEMPLATE_MENU_PRINCIPAL, "MENU", {});
}

function normKey(s) {
    return String(s || "")
        .trim()
        .toLowerCase()
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .replace(/[\u{1F300}-\u{1FAFF}]/gu, "")
        .replace(/[_-]+/g, " ")
        .replace(/\s+/g, " ")
        .trim();
}

// Muchos escriben su c\u00e9dula con puntos de miles ("12.345.678") o espacios
// ("1 2 3 4 5 6 7 8"); antes eso se rechazaba de una porque el regex exig\u00eda
// d\u00edgitos pegados. Se limpian esos separadores antes de validar.
function normalizeDocumentDigits(raw) {
    return String(raw || "").replace(/[.\s-]+/g, "");
}

// `isValidFullName` solo valida forma (letras y espacios), no significado:
// frases como "volver al inicio" o "no tengo" pasan esa validaci\u00f3n como si
// fueran un nombre real. Se detectan aparte, ANTES de aceptar el dato, para
// no guardarlas como si fueran el nombre/apellido del paciente.
const MENU_ESCAPE_PHRASES = new Set([
    "0",
    "menu",
    "inicio",
    "volver",
    "volver al menu",
    "volver al inicio",
    "menu principal",
]);

function isMenuEscapePhrase(raw) {
    return MENU_ESCAPE_PHRASES.has(normKey(raw));
}

// Para segundo nombre/apellido, "0" no es la única forma en que la gente dice
// que no tiene uno; sin esto, "no tengo" quedaba guardado literalmente como
// si fuera el segundo nombre/apellido del paciente.
const NO_SECOND_NAME_PHRASES = new Set([
    "0",
    "no",
    "no tengo",
    "ninguno",
    "ninguna",
]);

function isNoSecondNamePhrase(raw) {
    return NO_SECOND_NAME_PHRASES.has(normKey(raw));
}

function initializeGlobalSchedulingContext(data = {}) {
    if (!data.consultationMode) data.consultationMode = "PRESENCIAL";

    if (!data.origin) {
        data.origin = data.isPostOperative
            ? "POSOPERATORIO"
            : "CONSULTA_GENERAL";
    }

    data.aiSchedulingEnabled =
        AI_GLOBAL_SCHEDULING_ENABLED && data.aiSchedulingEnabled !== false;

    return data;
}

function parseHourButton(msg) {
    const raw = String(msg || "").trim().toLowerCase();
    const key = normKey(msg);

    // Payloads esperados desde la plantilla HX288...:
    // hora_1 ... hora_6 y mas_horarios.
    if (
        raw === "mas_horarios" ||
        key === "mas horarios" ||
        key === "ver mas horarios" ||
        key === "mas"
    ) {
        return "MORE";
    }

    const rawMatch = raw.match(/^hora[_\s-]*([1-6])$/);
    if (rawMatch) return Number(rawMatch[1]) - 1;

    const match = key.match(/^hora\s*([1-6])$/);
    if (match) return Number(match[1]) - 1;

    return null;
}

function normalizeDocType(msg) {
    const raw = String(msg || "")
        .trim()
        .toLowerCase()
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "");

    const key = raw
        .replace(/[._-]+/g, " ")
        .replace(/\s+/g, " ")
        .trim();

    const compact = key.replace(/\s+/g, "_");

    if (
        key === "1" ||
        key === "cc" ||
        key === "c c" ||
        compact === "doc_cc" ||
        compact === "tipo_cc" ||
        compact === "documento_cc" ||
        key.includes("cedula ciudadania") ||
        key.includes("cedula de ciudadania")
    ) {
        return 1;
    }

    if (
        key === "2" ||
        key === "ce" ||
        key === "c e" ||
        compact === "doc_ce" ||
        compact === "tipo_ce" ||
        compact === "documento_ce" ||
        key.includes("cedula extranjeria") ||
        key.includes("cedula de extranjeria")
    ) {
        return 2;
    }

    if (
        key === "3" ||
        key === "pasaporte" ||
        compact === "doc_pasaporte" ||
        compact === "tipo_pasaporte" ||
        compact === "documento_pasaporte"
    ) {
        return 4;
    }

    if (
        key === "4" ||
        key === "rc" ||
        key === "r c" ||
        compact === "doc_rc" ||
        compact === "tipo_rc" ||
        compact === "documento_rc" ||
        key.includes("registro civil")
    ) {
        return 5;
    }

    if (
        key === "5" ||
        key === "ti" ||
        key === "t i" ||
        compact === "doc_ti" ||
        compact === "tipo_ti" ||
        compact === "documento_ti" ||
        key.includes("tarjeta identidad") ||
        key.includes("tarjeta de identidad")
    ) {
        return 6;
    }

    return null;
}

function getFirstNameForTemplate(data = {}) {
    return data.firstName || splitName(data.fullName || "").firstName || "Paciente";
}

function sendDocTypeTemplate(data) {
    return sendTemplate(TEMPLATE_ASK_DOC_NUMBER, "AGENDAR", data, {
        "1": getFirstNameForTemplate(data),
    });
}

function parsePhoneE164ToDigits(phone) {
    const digits = String(phone || "").replace(/\D/g, "");
    if (digits.startsWith("57") && digits.length >= 12) return digits.slice(2);
    return digits;
}

function splitName(fullName = "") {
    const parts = String(fullName).trim().split(/\s+/).filter(Boolean);

    if (parts.length === 0) {
        return {
            firstName: "",
            secondName: "",
            firstLastName: "",
            secondLastName: "",
        };
    }

    if (parts.length === 1) {
        return {
            firstName: parts[0],
            secondName: "",
            firstLastName: "",
            secondLastName: "",
        };
    }

    if (parts.length === 2) {
        return {
            firstName: parts[0],
            secondName: "",
            firstLastName: parts[1],
            secondLastName: "",
        };
    }

    if (parts.length === 3) {
        // Con 3 palabras se asume 1 nombre + 2 apellidos (lo más común en
        // nombres colombianos), no 2 nombres + 1 apellido.
        return {
            firstName: parts[0],
            secondName: "",
            firstLastName: parts[1],
            secondLastName: parts[2],
        };
    }

    return {
        firstName: parts[0],
        secondName: parts.slice(1, parts.length - 2).join(" "),
        firstLastName: parts[parts.length - 2],
        secondLastName: parts[parts.length - 1],
    };
}

function isValidDateDDMM(value) {
    if (!/^\d{2}\/\d{2}$/.test(value)) return false;

    const [day, month] = value.split("/").map(Number);
    const year = new Date().getFullYear();
    const date = new Date(year, month - 1, day);

    // El Dr. requiere al menos 2 días de anticipación (T+2)
    const minDate = new Date();
    minDate.setHours(0, 0, 0, 0);
    minDate.setDate(minDate.getDate() + 2);

    return !isNaN(date.getTime()) && date >= minDate;
}

function isTooSoonDateRequest(value) {
    const key = normKey(value);

    // Lenguaje natural
    if (/\b(hoy|manana)\b/.test(key)) {
        return true;
    }

    // Fecha DD/MM
    if (!/^\d{2}\/\d{2}$/.test(String(value || ""))) {
        return false;
    }

    const [day, month] = String(value).split("/").map(Number);
    const year = new Date().getFullYear();
    const requestedDate = new Date(year, month - 1, day);

    // Validar que realmente exista la fecha
    if (
        requestedDate.getDate() !== day ||
        requestedDate.getMonth() !== month - 1
    ) {
        return false;
    }

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const minDate = new Date(today);
    minDate.setDate(minDate.getDate() + 2);

    // Solo hoy o mañana.
    // Fechas pasadas siguen tratándose como inválidas.
    return requestedDate >= today && requestedDate < minDate;
}

function ddmmToYmd(ddmm) {
    const [day, month] = ddmm.split("/").map(Number);
    const year = new Date().getFullYear();
    const d = new Date(year, month - 1, day);
    const yyyy = String(d.getFullYear()).padStart(4, "0");
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    const dd = String(d.getDate()).padStart(2, "0");
    return `${yyyy}-${mm}-${dd}`;
}

function addMinutesToYmdHm(ymd, hm, minutesToAdd) {
    const [H, M] = hm.split(":").map(Number);
    const [Y, Mo, D] = ymd.split("-").map(Number);
    const dt = new Date(Y, Mo - 1, D, H, M, 0, 0);
    dt.setMinutes(dt.getMinutes() + minutesToAdd);

    const yyyy = String(dt.getFullYear()).padStart(4, "0");
    const mm = String(dt.getMonth() + 1).padStart(2, "0");
    const dd = String(dt.getDate()).padStart(2, "0");
    const hh = String(dt.getHours()).padStart(2, "0");
    const min = String(dt.getMinutes()).padStart(2, "0");

    return { ymd: `${yyyy}-${mm}-${dd}`, hm: `${hh}:${min}` };
}

function normalizeBirthDateInput(value) {
    const raw = String(value || "").trim();

    if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;

    // Acepta también DD/MM/YYYY o DD-MM-YYYY para evitar loops con usuarios nuevos.
    const dmy = raw.match(/^(\d{2})[\/-](\d{2})[\/-](\d{4})$/);
    if (dmy) {
        const [, dd, mm, yyyy] = dmy;
        return `${yyyy}-${mm}-${dd}`;
    }

    return raw;
}

function isValidBirthDateYmd(value) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;

    const [year, month, day] = value.split("-").map(Number);
    const d = new Date(year, month - 1, day);
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    return (
        d.getFullYear() === year &&
        d.getMonth() === month - 1 &&
        d.getDate() === day &&
        d < today &&
        year >= 1900
    );
}

function normalizeEmail(value) {
    const s = String(value || "").trim();
    if (!s) return "";
    const ok = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
    return ok ? s : null;
}

function isCancelledStatus(status) {
    const s = String(status || "").toUpperCase();
    return s === "CANCELLED" || s === "CANCELED" || s === "FAILED";
}

function hmToMinutes(value) {
    const match = String(value || "").match(/^(\d{1,2}):(\d{2})/);
    if (!match) return null;
    return Number(match[1]) * 60 + Number(match[2]);
}

function intervalsOverlap(startA, endA, startB, endB) {
    return startA < endB && startB < endA;
}

async function findSaludtoolsPatientInDb({ docType, docNum }) {
    const [rows] = await db.query(
        `
        SELECT saludtools_id, full_name, document_type, document_number
        FROM saludtools_patients
        WHERE document_type = ?
          AND document_number = ?
        LIMIT 1
        `,
        [Number(docType), String(docNum)],
    );

    return rows?.[0] || null;
}

// El worker (saludtools.worker.js) procesa el job de creación en segundo plano
// y puede terminar (y avisarle al paciente "Tu cita fue creada correctamente")
// antes de que el paciente alcance a responder "Entendido" a esta plantilla.
// Sin esto, el bot le diría "seguimos procesando" a alguien cuya cita ya fue
// confirmada, lo cual suena contradictorio/roto.
async function getAppointmentStatusById(appointmentId) {
    if (!appointmentId) return null;

    try {
        const [rows] = await db.query(
            "SELECT status FROM appointments WHERE id = ? LIMIT 1",
            [appointmentId],
        );

        return rows?.[0]?.status || null;
    } catch {
        return null;
    }
}

async function getBookedHmFromDb({ ymd, doctorDoc }) {
    const [saludtoolsRows] = await db.query(
        `
        SELECT start_time, end_time, status
        FROM saludtools_appointments
        WHERE start_date = ?
          AND doctor_document_number = ?
        `,
        [ymd, String(doctorDoc)],
    );

    const [localRows] = await db.query(
        `
        SELECT
            scheduled_time AS start_time,
            ADDTIME(
                scheduled_time,
                SEC_TO_TIME(COALESCE(duration_minutes, ?) * 60)
            ) AS end_time,
            status
        FROM appointments
        WHERE scheduled_date = ?
          AND (
                UPPER(status) IN ('CONFIRMED', 'RESCHEDULED')
                OR (
                    UPPER(status) IN ('PROPOSED', 'QUEUED')
                    AND created_at >= DATE_SUB(NOW(), INTERVAL 30 MINUTE)
                )
          )
        `,
        [APPOINTMENT_DURATION_MIN, ymd],
    );

    // La tabla local `appointments` (previa a la integración con Saludtools)
    // no se actualiza cuando una cita se cancela o reagenda directamente en
    // Saludtools: puede quedar diciendo CONFIRMED para siempre en una hora que
    // ya está libre. Como no hay una relación directa entre las dos tablas
    // (solo coinciden por fecha/hora), la regla es: si el espejo de
    // Saludtools ya tiene un registro para esa hora exacta, su estado manda y
    // se ignora lo que diga la fila local para esa misma hora; la tabla local
    // solo se usa para horas que Saludtools todavía no conoce (ej: una cita
    // recién propuesta por el bot que aún no ha sincronizado).
    const saludtoolsTimesKnown = new Set(
        (Array.isArray(saludtoolsRows) ? saludtoolsRows : []).map((row) =>
            String(row.start_time),
        ),
    );

    const rows = [
        ...(Array.isArray(saludtoolsRows) ? saludtoolsRows : []),
        ...(Array.isArray(localRows) ? localRows : []).filter(
            (row) => !saludtoolsTimesKnown.has(String(row.start_time)),
        ),
    ].filter((row) => !isCancelledStatus(row.status));

    if (!rows.length) return [];

    const blocks = await getScheduleBlocksForYmd(ymd);
    if (!blocks.length) return [];

    const candidateSlots = buildSlotsForBlocks(blocks, SLOT_MIN);

    return candidateSlots.filter((hm) => {
        const candidateStart = hmToMinutes(hm);
        const candidateEnd = candidateStart + APPOINTMENT_DURATION_MIN;

        return rows.some((row) => {
            const existingStart = hmToMinutes(row.start_time);
            if (!Number.isFinite(existingStart)) return false;

            const parsedEnd = hmToMinutes(row.end_time);
            const existingEnd = Number.isFinite(parsedEnd)
                ? parsedEnd
                : existingStart + APPOINTMENT_DURATION_MIN;

            return intervalsOverlap(
                candidateStart,
                candidateEnd,
                existingStart,
                existingEnd,
            );
        });
    });
}

async function isSlotBookedInDb({ ymd, hm, doctorDoc }) {
    const booked = await getBookedHmFromDb({ ymd, doctorDoc });
    return booked.includes(hm);
}

const ALLOWED_DOC_TYPES = new Set([1, 2, 4, 5, 6]);
const ALLOWED_GENDERS = new Set([1, 2]);

function collapseSpaces(s) {
    return String(s || "")
        .replace(/\s+/g, " ")
        .trim();
}

function sanitizeName(s) {
    const v = collapseSpaces(s);
    const cleaned = v.replace(/[^A-Za-zÁÉÍÓÚÜÑáéíóúüñ\s'-]/g, "");
    return collapseSpaces(cleaned);
}

function isValidDigits(str, min, max) {
    const v = String(str || "");
    if (!/^\d+$/.test(v)) return false;
    return v.length >= min && v.length <= max;
}

function isValidPhoneDigits(v) {
    return isValidDigits(v, 7, 15);
}

function validateAndNormalizePatientBody(patientBody) {
    const b = { ...patientBody };

    b.firstName = sanitizeName(b.firstName);
    b.secondName = sanitizeName(b.secondName);
    b.firstLastName = sanitizeName(b.firstLastName);
    b.secondLastName = sanitizeName(b.secondLastName);

    b.gender = Number(b.gender);
    b.documentType = Number(b.documentType);

    b.documentNumber = String(b.documentNumber || "").trim();
    b.birthDate = String(b.birthDate || "").trim();
    b.email = String(b.email || "").trim();

    b.phone = String(b.phone || "").trim();
    b.cellPhone = String(b.cellPhone || "").trim();

    const epsNum = Number(b.eps || 0);
    b.eps = Number.isFinite(epsNum) && epsNum > 0 ? epsNum : 0;

    b.habeasData = Boolean(b.habeasData);

    if (!b.firstName || b.firstName.length < 2) {
        return {
            ok: false,
            step: "REG_FIRSTNAME",
            message: "Primer nombre inválido. Escríbelo nuevamente:",
        };
    }
    if (!b.firstLastName || b.firstLastName.length < 2) {
        return {
            ok: false,
            step: "REG_FIRSTLASTNAME",
            message: "Primer apellido inválido. Escríbelo nuevamente:",
        };
    }

    if (!isValidBirthDateYmd(b.birthDate)) {
        return {
            ok: false,
            step: "REG_BIRTHDATE",
            message: "Fecha inválida. Usa YYYY-MM-DD. Ej: 1967-12-05",
        };
    }

    if (!ALLOWED_GENDERS.has(b.gender)) {
        return {
            ok: false,
            step: "REG_GENDER",
            message: "Elige 1 o 2, o 0 para volver al menú.",
        };
    }

    if (!ALLOWED_DOC_TYPES.has(b.documentType)) {
        return {
            ok: false,
            step: "ASK_DOC_TYPE",
            message:
                "Selecciona tu tipo de documento:\n\n1️⃣ CC\n2️⃣ CE\n\n0️⃣ Volver al menú",
        };
    }

    if (!isValidDigits(b.documentNumber, 5, 20)) {
        return {
            ok: false,
            step: "ASK_DOC_NUMBER",
            message:
                "Número inválido. Por favor escribe solo números (mínimo 5 dígitos):",
        };
    }

    if (!isValidPhoneDigits(b.phone) || !isValidPhoneDigits(b.cellPhone)) {
        return {
            ok: false,
            step: "REG_HABEAS",
            message:
                "No pude validar el número de contacto. Intentemos nuevamente la confirmación de datos (Habeas Data):\n\n1️⃣ Sí, autorizo\n2️⃣ No autorizo\n\n0️⃣ Volver al menú",
        };
    }

    if (b.email) {
        const em = normalizeEmail(b.email);
        if (em === null) {
            return {
                ok: false,
                step: "REG_EMAIL",
                message: "Correo inválido. Intenta de nuevo o escribe 0:",
            };
        }
        b.email = em;
    } else {
        b.email = "";
    }

    return { ok: true, body: b };
}

// Debe ser igual a APPOINTMENT_DURATION_MIN: cada slot ofrecido debe durar exactamente
// lo mismo que la cita que va a ocupar, para que no queden huecos ni cruces.
const SLOT_MIN = APPOINTMENT_DURATION_MIN;

function pad2(n) {
    return String(n).padStart(2, "0");
}

function dateToYmd(date) {
    return [date.getFullYear(), pad2(date.getMonth() + 1), pad2(date.getDate())].join("-");
}

function buildSlots(startHm, endHm, slotMin = SLOT_MIN) {
    const [sh, sm] = startHm.split(":").map(Number);
    const [eh, em] = endHm.split(":").map(Number);

    const startTotal = sh * 60 + sm;
    const endTotal = eh * 60 + em;

    const lastStart = endTotal - slotMin;
    const slots = [];

    for (let t = startTotal; t <= lastStart; t += slotMin) {
        const h = Math.floor(t / 60);
        const m = t % 60;
        slots.push(`${pad2(h)}:${pad2(m)}`);
    }
    return slots;
}

// El horario semanal (con su descanso de mediodía), los festivos y los
// bloqueos manuales de la secretaria viven en doctor-schedule.service.js
// (compartido con soporteCita.state.js) para que agendar/reagendar/cancelar
// nunca vean disponibilidad distinta para el mismo día.
function buildSlotsForBlocks(blocks, slotMin = SLOT_MIN) {
    return blocks.flatMap((block) => buildSlots(block.start, block.end, slotMin));
}

async function getSlotsForDate(ymd, page = 0, dayPart = null) {
    const blocks = await getScheduleBlocksForYmd(ymd);
    if (!blocks.length) return [];

    let all = buildSlotsForBlocks(blocks, SLOT_MIN);
    if (dayPart === "MORNING") {
        all = all.filter((hm) => Number(hm.slice(0, 2)) < 12);
    } else if (dayPart === "AFTERNOON") {
        all = all.filter((hm) => Number(hm.slice(0, 2)) >= 12);
    }

    const pageSize = 6;
    const from = page * pageSize;
    return all.slice(from, from + pageSize);
}

function ymdToDateLabel(ymd) {
    const [, month, day] = String(ymd || "").split("-");
    return `${day}/${month}`;
}

function formatDateForRecommendation(ymd) {
    const [year, month, day] = String(ymd || "").split("-").map(Number);
    const date = new Date(year, month - 1, day);
    const weekday = new Intl.DateTimeFormat("es-CO", {
        weekday: "long",
    }).format(date);
    return `${weekday} ${pad2(day)}/${pad2(month)}`;
}

function isRecommendationRequest(value) {
    const key = normKey(value);

    // No debe interpretar como "recomiéndame una fecha" un mensaje donde el
    // paciente en realidad está desistiendo o pidiendo cancelar, ej: "ya no
    // necesito la cita" o "necesito cancelar la cita ya".
    if (
        /\b(cancelar|cancela|reagendar|reprogramar)\b/.test(key) ||
        /\bya\s+no\b/.test(key) ||
        /\bno\s+necesito\b/.test(key) ||
        /\bno\s+quiero\b/.test(key)
    ) {
        return false;
    }

    return (
        key === "recomendar" ||
        key === "recomendacion" ||
        key === "sugerir" ||
        key === "sugerencia" ||
        key.includes("recomiend") ||
        key.includes("recomend") ||
        key.includes("sugier") ||
        key.includes("mejor horario") ||
        key.includes("mejor fecha") ||
        key.includes("proxima disponibilidad") ||
        key.includes("primera disponibilidad") ||
        key.includes("lo mas pronto") ||
        key.includes("proximo horario") ||
        key.includes("proxima fecha") ||
        key.includes("lo antes posible") ||
        key.includes("cuanto antes") ||
        key.includes("primera que haya") ||
        key.includes("primera que tenga") ||
        key.includes("cuando haya") ||
        key.includes("cita mas cercana") ||
        key.includes("fecha mas cercana") ||
        key.includes("primera cita disponible") ||
        key.includes("urgente") ||
        /\bpara\s+ya\b/.test(key) ||
        /\bya\s+mismo\b/.test(key) ||
        (/\bnecesito\b/.test(key) && /\bcita\b/.test(key) && /\bya\b/.test(key)) ||
        key.includes("cualquier horario") ||
        key.includes("cualquier dia") ||
        key.includes("esta semana") ||
        key.includes("proxima semana") ||
        key.includes("la semana que viene") ||
        key.includes("por la manana") ||
        key.includes("en la manana") ||
        key.includes("por la tarde") ||
        key.includes("en la tarde") ||
        key.includes("despues de las") ||
        key.includes("antes de las") ||
        /\b(lunes|martes|miercoles|jueves|viernes)\b/.test(key)
    );
}

function detectDayPartPreference(value) {
    const key = normKey(value);
    if (key.includes("tarde")) return "AFTERNOON";
    if (key.includes("manana") || key.includes("temprano")) return "MORNING";
    return "ANY";
}

function orderSlotsByPreference(slots, preference) {
    const morning = slots.filter((slot) => Number(slot.slice(0, 2)) < 12);
    const afternoon = slots.filter((slot) => Number(slot.slice(0, 2)) >= 12);

    if (preference === "AFTERNOON") return [...afternoon, ...morning];
    if (preference === "MORNING") return [...morning, ...afternoon];
    return slots;
}

function addDays(date, days) {
    const copy = new Date(date);
    copy.setDate(copy.getDate() + days);
    copy.setHours(0, 0, 0, 0);
    return copy;
}

function maxDate(a, b) {
    return a > b ? a : b;
}

const MONTH_NUMBER_BY_NAME = {
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

// Resuelve un día suelto ("el 31") o día+mes ("31 de agosto") a la próxima
// fecha real que corresponde, sin importar si ese día ya pasó este mes/año.
function resolveUpcomingYmdForDay(day, month, notBefore) {
    if (!Number.isFinite(day) || day < 1 || day > 31) return null;

    let year = notBefore.getFullYear();
    let m = month || notBefore.getMonth() + 1;

    for (let i = 0; i < 24; i += 1) {
        const candidate = new Date(year, m - 1, day, 0, 0, 0, 0);
        // Si el día no existe en ese mes (ej: 31 de febrero), Date lo
        // desborda al mes siguiente; se detecta comparando el mes resultante.
        const isRealDate = candidate.getMonth() === m - 1;

        if (isRealDate && candidate >= notBefore) {
            return candidate;
        }

        if (month) {
            // Mes explícito y ya pasó (o no existe): se prueba el año siguiente.
            year += 1;
        } else {
            m += 1;
            if (m > 12) {
                m = 1;
                year += 1;
            }
        }
    }

    return null;
}

function getSchedulingDateWindow(value) {
    const key = normKey(value);
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const minDate = addDays(today, 2);

    // "el 31", "para el 5", "31 de agosto en la tarde": antes esto no se
    // reconocía como una fecha concreta y el buscador de candidatos escaneaba
    // varios días distintos desde hoy+2 en adelante (con un tope de 2
    // horarios por día pensado para diversificar un rango), así que la fecha
    // pedida terminaba mostrando como mucho 2 horas de las muchas reales que
    // tenía disponibles.
    const monthNamesPattern = Object.keys(MONTH_NUMBER_BY_NAME).join("|");
    const dayWithMonthMatch = key.match(
        new RegExp(`\\b([0-3]?\\d)\\s+de\\s+(${monthNamesPattern})\\b`),
    );
    const bareDayMatch =
        !dayWithMonthMatch && key.match(/\bel\s+([0-3]?\d)\b/);

    if (dayWithMonthMatch || bareDayMatch) {
        const day = Number((dayWithMonthMatch || bareDayMatch)[1]);
        const month = dayWithMonthMatch
            ? MONTH_NUMBER_BY_NAME[dayWithMonthMatch[2]]
            : null;
        const resolved = resolveUpcomingYmdForDay(day, month, minDate);

        if (resolved) {
            return { start: resolved, end: resolved };
        }
    }

    if (key.includes("proxima semana") || key.includes("la semana que viene")) {
        const daysUntilNextMonday = ((8 - today.getDay()) % 7) || 7;
        const start = addDays(today, daysUntilNextMonday);
        return { start: maxDate(start, minDate), end: addDays(start, 6) };
    }

    if (key.includes("esta semana")) {
        const end = addDays(today, 7 - today.getDay());
        return { start: minDate, end };
    }

    const weekdayMap = {
        domingo: 0,
        lunes: 1,
        martes: 2,
        miercoles: 3,
        jueves: 4,
        viernes: 5,
        sabado: 6,
    };
    const weekdayName = Object.keys(weekdayMap).find((name) =>
        new RegExp(`\\b${name}\\b`).test(key),
    );

    if (weekdayName) {
        const targetDow = weekdayMap[weekdayName];
        const startFrom = key.includes(`proximo ${weekdayName}`)
            ? addDays(today, 1)
            : minDate;
        let target = new Date(startFrom);

        for (let index = 0; index < 14; index += 1) {
            if (target.getDay() === targetDow && target >= minDate) {
                return { start: target, end: target };
            }
            target = addDays(target, 1);
        }
    }

    return { start: minDate, end: null };
}

function filterSlotsByTimeConstraint(slots, value) {
    const key = normKey(value);
    const parseHour = (match, assumeAfternoon = false) => {
        if (!match) return null;
        let hour = Number(match[1]);
        const minute = Number(match[2] || 0);
        if (assumeAfternoon && hour >= 1 && hour <= 7) hour += 12;
        return hour * 60 + minute;
    };

    const afterMatch = key.match(/despues de las?\s+(\d{1,2})(?::(\d{2}))?/);
    const beforeMatch = key.match(/antes de las?\s+(\d{1,2})(?::(\d{2}))?/);
    const afterMinutes = parseHour(afterMatch, true);
    const beforeMinutes = parseHour(beforeMatch, false);

    const filtered = slots.filter((slot) => {
        const minutes = hmToMinutes(slot);
        if (minutes == null) return false;
        if (afterMinutes != null && minutes < afterMinutes) return false;
        if (beforeMinutes != null && minutes >= beforeMinutes) return false;
        return true;
    });

    return filtered.length ? filtered : slots;
}

async function findRealAppointmentCandidates(message, maxCandidates = 9) {
    const preference = detectDayPartPreference(message);
    const candidates = [];
    const dateWindow = getSchedulingDateWindow(message);
    const cursor = new Date(dateWindow.start);

    // El paciente pidió un día exacto (ej: "el 31", "31 de agosto"), no un
    // rango: no tiene sentido limitar a 2 horarios "para diversificar entre
    // días" cuando solo hay un día. En ese caso se consideran todos los
    // horarios reales de ese día (hasta el máximo de candidatos general).
    const isSingleExactDate =
        dateWindow.end &&
        dateWindow.start.getTime() === dateWindow.end.getTime();
    const perDateLimit = isSingleExactDate ? maxCandidates : 2;

    for (let offset = 0; offset < 75 && candidates.length < maxCandidates; offset += 1) {
        const date = new Date(cursor);
        date.setDate(cursor.getDate() + offset);

        if (dateWindow.end && date > dateWindow.end) break;

        const ymd = dateToYmd(date);
        const blocks = await getScheduleBlocksForYmd(ymd);
        if (!blocks.length) continue;

        let booked = [];
        try {
            booked = await getBookedHmFromDb({
                ymd,
                doctorDoc: DOCTOR_DOCUMENT_NUMBER,
            });
        } catch (error) {
            if (SALUDTOOLS_DEBUG) {
                console.error("DB recommendation slots error:", error);
            }
        }

        const bookedSet = new Set(Array.isArray(booked) ? booked : []);
        const freeSlots = orderSlotsByPreference(
            filterSlotsByTimeConstraint(
                buildSlotsForBlocks(blocks, SLOT_MIN).filter(
                    (slot) => !bookedSet.has(slot),
                ),
                message,
            ),
            preference,
        );

        // Por defecto, máximo dos alternativas por fecha para mantener
        // diversidad entre varios días; si el paciente pidió un día exacto,
        // perDateLimit ya es el máximo general (ver arriba).
        for (const slot of freeSlots.slice(0, perDateLimit)) {
            candidates.push({
                candidateId: `candidate_${candidates.length + 1}`,
                ymd,
                dateLabel: ymdToDateLabel(ymd),
                dateText: formatDateForRecommendation(ymd),
                timeLabel: slot,
                dayPart:
                    Number(slot.slice(0, 2)) < 12 ? "MORNING" : "AFTERNOON",
            });
            if (candidates.length >= maxCandidates) break;
        }
    }

    return candidates;
}

async function buildRecommendedAppointmentResponse(message, data) {
    if (!data.aiSchedulingEnabled) {
        return {
            response:
                "La recomendación automática de horarios está desactivada temporalmente.\n\n" +
                "Escribe la fecha en formato DD/MM para continuar.",
            nextState: "AGENDAR",
            data,
        };
    }

    const candidates = await findRealAppointmentCandidates(message);
    if (!candidates.length) {
        data.aiRecommendations = [];
        return {
            response:
                "No encontré disponibilidad próxima para recomendarte en este momento.\n\n" +
                "Escribe una fecha en formato DD/MM o vuelve a intentarlo más tarde.",
            nextState: "AGENDAR",
            data,
        };
    }

    const aiResult = await recommendAppointmentOptionsAI({
        message,
        candidates,
        consultationMode: data.consultationMode || "PRESENCIAL",
    });

    const selected = (aiResult?.options?.length
        ? aiResult.options
        : candidates.slice(0, 3)
    ).slice(0, 3);

    data.aiRecommendations = selected.map((item) => ({
        candidateId: item.candidateId,
        ymd: item.ymd,
        date: item.dateLabel,
        dateText: item.dateText,
        time: item.timeLabel,
        reason: item.reason || "Primera disponibilidad encontrada",
    }));

    const intro = aiResult?.intro || "Encontré estas opciones de agenda para ti:";
    const note = aiResult?.note || "La disponibilidad se valida nuevamente al seleccionar.";
    const recs = data.aiRecommendations;

    // Plantilla con botones reales según cuántas opciones encontró la IA (1 a
    // 3 — es lo máximo que se recomienda). El número de opciones cambia cada
    // vez, así que hace falta una plantilla distinta por cada cantidad.
    if (recs.length === 1) {
        return sendTemplate(TEMPLATE_RECOMENDACION_1, "AGENDAR", data, {
            "1": intro,
            "2": recs[0].dateText,
            "3": recs[0].time,
            "4": recs[0].reason,
            "5": note,
        });
    }
    if (recs.length === 2) {
        return sendTemplate(TEMPLATE_RECOMENDACION_2, "AGENDAR", data, {
            "1": intro,
            "2": recs[0].dateText,
            "3": recs[0].time,
            "4": recs[0].reason,
            "5": recs[1].dateText,
            "6": recs[1].time,
            "7": recs[1].reason,
            "8": note,
        });
    }
    return sendTemplate(TEMPLATE_RECOMENDACION_3, "AGENDAR", data, {
        "1": intro,
        "2": recs[0].dateText,
        "3": recs[0].time,
        "4": recs[0].reason,
        "5": recs[1].dateText,
        "6": recs[1].time,
        "7": recs[1].reason,
        "8": recs[2].dateText,
        "9": recs[2].time,
        "10": recs[2].reason,
        "11": note,
    });
}

async function buildRecommendedTimeResponse(message, data) {
    if (!data.aiSchedulingEnabled) {
        return {
            response:
                "La recomendación automática de horarios está desactivada temporalmente.\n\n" +
                "Selecciona una de las horas disponibles o escribe otra fecha en formato DD/MM.",
            nextState: "AGENDAR",
            data,
        };
    }

    const blocks = await getScheduleBlocksForYmd(data.ymd);
    if (!blocks.length) {
        return {
            response:
                `El Dr. no tiene atención el día ${data.date}.\n\n` +
                "Escribe otra fecha en formato DD/MM o pide una recomendación de fecha.",
            nextState: "AGENDAR",
            data,
        };
    }

    let booked = [];
    try {
        booked = await getBookedHmFromDb({
            ymd: data.ymd,
            doctorDoc: DOCTOR_DOCUMENT_NUMBER,
        });
    } catch (error) {
        if (SALUDTOOLS_DEBUG) {
            console.error("DB recommended time slots error:", error);
        }
    }

    const bookedSet = new Set(Array.isArray(booked) ? booked : []);
    const availableSlots = orderSlotsByPreference(
        filterSlotsByTimeConstraint(
            buildSlotsForBlocks(blocks, SLOT_MIN).filter(
                (slot) => !bookedSet.has(slot),
            ),
            message,
        ),
        detectDayPartPreference(message),
    );

    const candidates = availableSlots.slice(0, 9).map((slot, index) => ({
        candidateId: `time_candidate_${index + 1}`,
        ymd: data.ymd,
        dateLabel: data.date,
        dateText: formatDateForRecommendation(data.ymd),
        timeLabel: slot,
        dayPart: Number(slot.slice(0, 2)) < 12 ? "MORNING" : "AFTERNOON",
    }));

    if (!candidates.length) {
        data.aiTimeRecommendations = [];
        data.aiTimeRecommendationActive = false;
        return {
            response:
                `No encontré horarios disponibles para ${data.date}.\n\n` +
                "Escribe otra fecha en formato DD/MM o pide una recomendación de fecha.",
            nextState: "AGENDAR",
            data,
        };
    }

    const aiResult = await recommendAppointmentOptionsAI({
        message,
        candidates,
        consultationMode: data.consultationMode || "PRESENCIAL",
    });

    const selected = (aiResult?.options?.length
        ? aiResult.options
        : candidates.slice(0, 3)
    ).slice(0, 3);

    data.aiTimeRecommendations = selected.map((item) => ({
        candidateId: item.candidateId,
        ymd: item.ymd,
        date: item.dateLabel,
        time: item.timeLabel,
        reason: item.reason || "Horario disponible según tu preferencia",
    }));
    data.aiTimeRecommendationActive = true;

    const lines = data.aiTimeRecommendations.map(
        (item, index) => `${index + 1}️⃣ ${item.time} — ${item.reason}`,
    );

    return {
        response:
            `🤖 Para el ${data.date}, estas son las opciones más convenientes:\n\n` +
            `${lines.join("\n")}\n\n` +
            "Responde 1, 2 o 3 para elegir. También puedes escribir otra fecha en formato DD/MM.\n\n" +
            `${aiResult?.note || "La disponibilidad se valida nuevamente al seleccionar."}\n\n` +
            "0️⃣ Volver al menú",
        nextState: "AGENDAR",
        data,
    };
}

function buildAskDateMessage() {
    return (
        "📅 ¿Qué fecha te gustaría para tu cita?\n\n" +
        "Recuerda que las citas deben agendarse con mínimo 2 días de anticipación.\n\n" +
        "Puedes escribir la fecha en formato DD/MM o decirme tu preferencia, por ejemplo:\n" +
        "• “Lo más pronto posible”\n" +
        "• “La próxima semana en la tarde”\n" +
        "• “En la mañana”\n\n" +
        "Yo te ayudaré a encontrar las opciones disponibles que mejor se ajusten 😊\n\n" +
        "0️⃣ Volver al menú"
    );
}

function fallbackPreparationTips(data) {
    if (data.consultationMode === "TELECONSULTA") {
        return [
            "Ten listos tus estudios e informes en formato digital.",
            "Verifica tu conexión a internet y busca un espacio con buena iluminación.",
            "Mantén a la mano tu documento y las preguntas que deseas revisar.",
        ];
    }

    return [
        "Ten a la mano tu documento y los estudios o informes previos.",
        "Si utilizas póliza o medicina prepagada, verifica previamente la autorización.",
        "Procura llegar con 15 minutos de anticipación.",
    ];
}

// Compartido entre "elige un horario" (cuando ya sabemos por el registro de
// esta sesión que la consulta es particular, así que no tiene sentido
// volver a preguntarlo) y el case "ASK_TYPE" (cuando sí hace falta
// preguntar). Arma el mensaje de costos/preparación y deja la cita lista
// para la confirmación final.
async function finalizeAttentionType(data, phone, attentionType) {
    data.attentionType = attentionType;

    const aiPreparationTips = await generateAppointmentPreparationTipsAI({
        consultationMode: data.consultationMode || "PRESENCIAL",
        attentionType: data.attentionType,
        appointmentDate: data.date,
        appointmentTime: data.time,
    });
    const preparationTips = aiPreparationTips || fallbackPreparationTips(data);
    data.preparationTips = preparationTips;

    const preparationLabel = aiPreparationTips
        ? "🤖 Recomendaciones personalizadas de preparación:"
        : "Recomendaciones de preparación:";
    const preparationText = preparationTips
        .map((tip) => `• ${tip}`)
        .join("\n");

    data.step = "SHOW_COST_INFO";

    // El texto de costos/EPS varía con cada tipo de atención (no cabe en
    // el body fijo de una plantilla de WhatsApp), así que se manda como
    // mensaje aparte; la pregunta de confirmar sí llega con botones reales.
    try {
        await sendWhatsAppMessage(
            phone,
            `${preparationLabel}\n\n` +
                `${preparationText}\n\n` +
                "Estas recomendaciones son administrativas y no reemplazan la valoración médica.",
        );
    } catch (error) {
        console.error(
            "❌ No fue posible enviar las recomendaciones de preparación:",
            error,
        );
    }

    return sendTemplate(TEMPLATE_CONFIRM_CITA, "AGENDAR", data);
}

async function buildTimeResponse(data) {
    data.aiTimeRecommendations = [];
    data.aiTimeRecommendationActive = false;

    const ymd = data.ymd;
    const page = Number(data.page || 0);
    const dayPart = data.dayPartPreference || null;
    const dayPartLabel =
        dayPart === "MORNING"
            ? " en la mañana"
            : dayPart === "AFTERNOON"
              ? " en la tarde"
              : "";
    const slotsAll = await getSlotsForDate(ymd, page, dayPart);

    if (!slotsAll.length) {
        if (page > 0) {
            data.page = 0;
            return {
                response:
                    `No hay más horarios${dayPartLabel} disponibles para ${data.date}.\n\n` +
                    "Puedes escribir otra fecha en formato DD/MM o seleccionar una de las horas anteriores.",
                nextState: "AGENDAR",
                data,
            };
        }

        return {
            response: dayPart
                ? `No encontré horarios${dayPartLabel} disponibles para ${data.date}.\n\n` +
                  "Escribe otra fecha (DD/MM), pide la otra franja del día, o 0 para volver al menú."
                : `El Dr. no tiene atención el día ${data.date}.\n\n` +
                  "Escribe otra fecha (DD/MM) o 0 para volver al menú.",
            nextState: "AGENDAR",
            data,
        };
    }

    const booked = new Set(Array.isArray(data.bookedHm) ? data.bookedHm : []);
    const slots = slotsAll.filter((h) => !booked.has(h));
    data.visibleSlots = slots;

    if (!slots.length) {
        return {
            response:
                `No veo horarios disponibles para ${data.date} en esta página.\n\n` +
                "Escribe otra fecha en formato DD/MM o pulsa Más horarios si aparece disponible.",
            nextState: "AGENDAR",
            data,
        };
    }

    const variables = {
        "1": data.date,
        "2": slots[0] || "🚫 No disponible",
        "3": slots[1] || "🚫 No disponible",
        "4": slots[2] || "🚫 No disponible",
        "5": slots[3] || "🚫 No disponible",
        "6": slots[4] || "🚫 No disponible",
        "7": slots[5] || "🚫 No disponible",
    };

    return sendTemplate(TEMPLATE_AVAILABLE_HOURS, "AGENDAR", data, variables);
}

// Evita que texto pegado por error (varios mensajes del bot copiados, botones,
// etc.) quede guardado como el nombre del paciente. Un nombre real: solo
// letras/espacios/guiones/apóstrofes, sin saltos de línea, y un número
// razonable de palabras.
function isValidFullName(msg, minLength = 3) {
    const raw = String(msg || "").trim();
    if (raw.length < minLength || raw.length > 60) return false;
    if (/[\n\r]/.test(raw)) return false;
    if (!/^[A-Za-zÀ-ÖØ-öø-ÿÑñ]+(?:[\s'-]+[A-Za-zÀ-ÖØ-öø-ÿÑñ]+)*$/.test(raw)) {
        return false;
    }
    if (raw.split(/\s+/).length > 6) return false;
    return true;
}

// isValidFullName solo valida forma, no cuántas palabras trae: "Jose" pasaba
// como "nombre completo" válido y el registro seguía sin apellido hasta que
// validateAndNormalizePatientBody lo rebotaba al final de todo el flujo
// (después de fecha, hora, EPS, etc.). Este chequeo aparte es solo para
// ASK_NAME, donde sí necesitamos nombre + al menos un apellido de una vez.
function hasAtLeastTwoWords(msg) {
    return String(msg || "").trim().split(/\s+/).filter(Boolean).length >= 2;
}

function capitalize(str) {
    if (!str) return "";
    return String(str)
        .trim()
        .split(/\s+/)
        .map(
            (word) =>
                word.charAt(0).toUpperCase() + word.slice(1).toLowerCase(),
        )
        .join(" ");
}

async function normalizeAgendarMessage(msg, step, data) {
    const raw = String(msg || "").trim();
    if (!raw) return raw;

    const key = normKey(raw);
    const compactKey = key.replace(/\s+/g, "_");

    // Resolver primero respuestas frecuentes y payloads de botones sin depender de IA.
    if (
        key === "menu" ||
        key === "inicio" ||
        key === "volver" ||
        key === "volver al menu" ||
        compactKey === "volver_menu" ||
        compactKey === "menu_principal"
    ) {
        return "0";
    }

    const binarySteps = new Set([
        "REG_CONFIRM_NAMES",
        "REG_HABEAS",
        "FILTRO_COLUMNA",
        "FILTRO_CONFIRM",
        "SHOW_COST_INFO",
        "POST_CREATED",
    ]);

    if (binarySteps.has(step)) {
        if (
            key === "si" ||
            key === "sí" ||
            key === "confirmar" ||
            key === "continuar" ||
            compactKey === "columna_si" ||
            compactKey === "dolor_columna_si" ||
            compactKey === "filtro_columna_si" ||
            compactKey === "consulta_cervical" 
        ) {
            return "1";
        }

        if (
            key === "no" ||
            key === "no continuar" ||
            compactKey === "columna_no" ||
            compactKey === "dolor_columna_no" ||
            compactKey === "filtro_columna_no" ||
            compactKey === "consulta_no_cervical" 
        ) {
            return "2";
        }
    }

    // Primero respetamos payloads exactos de botones/plantillas.
    if (/^(0|1|2|3|4|5|6|7)$/.test(raw)) return raw;
    if (/^hora[_\s-]*[1-6]$/i.test(raw)) return raw;
    if (/^mas[_\s-]*horarios$/i.test(raw)) return "mas_horarios";
    if (/^\d{2}\/\d{2}$/.test(raw)) return raw;
    if (
        step === "ASK_DATE" &&
        (compactKey === "agenda_escribir_fecha" ||
            compactKey === "escribir_fecha" ||
            key === "escribir fecha")
    ) {
        return "ESCRIBIR_FECHA";
    }
    if (step === "ASK_DATE" && isTooSoonDateRequest(raw)) {
        return raw;
    }
    if (
        (step === "ASK_DATE" || step === "ASK_TIME") &&
        isRecommendationRequest(raw)
    ) {
        return `RECOMENDAR:${raw}`;
    }
    if (step === "REG_BIRTHDATE") return normalizeBirthDateInput(raw);

    // Estos pasos son texto libre (nombre, documento, contacto) que el propio
    // "case" del switch valida directamente con su propia regla; no dependen del
    // resultado de la IA en ningún caso, así que se excluyen para no gastar una
    // llamada real a Azure OpenAI (2-3 segundos extra) sin ningún beneficio.
    const FREE_TEXT_NO_AI_STEPS = new Set([
        "ASK_NAME",
        "ASK_DOC_NUMBER",
        "REG_FIRSTNAME",
        "REG_SECONDNAME",
        "REG_FIRSTLASTNAME",
        "REG_SECONDLASTNAME",
        "REG_EMAIL",
        "REG_PHONE",
        "REG_EPS",
    ]);
    if (FREE_TEXT_NO_AI_STEPS.has(step)) return raw;

    const parsed = await normalizeAppointmentInputAI({ message: raw, step, data });
    if (!parsed || parsed.confidence < 0.7) return raw;

    switch (parsed.intent) {
        case "BACK_MENU":
            return "0";
        case "YES":
        case "CONTINUE":
            return "1";
        case "NO":
            return "2";
        case "DOC_TYPE":
            return String(parsed.value || raw);
        case "DATE_DDMM":
            return String(parsed.value || raw);
        case "HOUR_BUTTON":
            return String(parsed.value || raw);
        case "MORE_HOURS":
            return "mas_horarios";
        case "ATTENTION_TYPE":
            return String(parsed.value || raw);
        case "RECOMMENDATION":
            return `RECOMENDAR:${raw}`;
        default:
            return raw;
    }
}

// Antes, si el paciente escribía algo como "uy me equivoqué en la pregunta
// anterior" en un paso de texto libre del registro (ej: REG_EPS), el bot no
// tenía forma de reconocerlo: lo guardaba tal cual como si fuera la
// respuesta válida de ese paso (ej: como nombre de la EPS) y seguía de
// largo, sin ninguna manera de corregir un dato ya dado. Esto detecta esa
// intención y retrocede un paso para volver a preguntarlo.
const PREVIOUS_STEP_BY_STEP = {
    ASK_DOC_TYPE: "ASK_NAME",
    ASK_DOC_NUMBER: "ASK_DOC_TYPE",
    REG_CONFIRM_NAMES: "ASK_DOC_NUMBER",
    REG_FIRSTNAME: "REG_CONFIRM_NAMES",
    REG_SECONDNAME: "REG_FIRSTNAME",
    REG_FIRSTLASTNAME: "REG_SECONDNAME",
    REG_SECONDLASTNAME: "REG_FIRSTLASTNAME",
    REG_BIRTHDATE: "REG_CONFIRM_NAMES",
    REG_GENDER: "REG_BIRTHDATE",
    REG_EMAIL: "REG_GENDER",
    REG_PHONE: "REG_EMAIL",
    REG_EPS: "REG_PHONE",
    REG_HABEAS: "REG_EPS",
};

// Filtro barato antes de gastar una llamada real a Azure OpenAI: una
// respuesta normal en estos pasos (un nombre, un correo, un número, "cc",
// "particular"...) es corta. Solo vale la pena preguntarle a la IA qué quiso
// decir el paciente cuando el mensaje ya "se ve raro" para una respuesta
// puntual: trae varias palabras o parece una pregunta.
function looksLikeUnexpectedInput(msg) {
    const raw = String(msg || "").trim();
    if (!raw) return false;

    const wordCount = raw.split(/\s+/).filter(Boolean).length;
    return wordCount >= 4 || /[?¿]/.test(raw);
}

function buildStepPrompt(step, data) {
    switch (step) {
        case "ASK_NAME":
            return {
                response: "¿Cuál es tu nombre completo?",
                nextState: "AGENDAR",
                data,
            };
        case "ASK_DOC_TYPE":
            return sendDocTypeTemplate(data);
        case "ASK_DOC_NUMBER":
            return sendTemplate(TEMPLATE_REG_DOCUMENT_NUMBER, "AGENDAR", data);
        case "REG_CONFIRM_NAMES":
            return sendTemplate(TEMPLATE_REG_CONFIRM_NAMES, "AGENDAR", data, {
                "1": capitalize(data.regPatient?.firstName) || "(vacío)",
                "2": capitalize(data.regPatient?.secondName) || "(vacío)",
                "3": capitalize(data.regPatient?.firstLastName) || "(vacío)",
                "4": capitalize(data.regPatient?.secondLastName) || "(vacío)",
            });
        case "REG_FIRSTNAME":
            return sendTemplate(TEMPLATE_REG_FIRSTNAME, "AGENDAR", data);
        case "REG_SECONDNAME":
            return sendTemplate(TEMPLATE_REG_SECONDNAME, "AGENDAR", data);
        case "REG_FIRSTLASTNAME":
            return { response: "Primer apellido:", nextState: "AGENDAR", data };
        case "REG_SECONDLASTNAME":
            return {
                response: "Segundo apellido (si no tienes, escribe 0):",
                nextState: "AGENDAR",
                data,
            };
        case "REG_BIRTHDATE":
            return sendTemplate(TEMPLATE_REG_BIRTHDATE, "AGENDAR", data);
        case "REG_GENDER":
            return sendTemplate(TEMPLATE_REG_GENDER, "AGENDAR", data);
        case "REG_EMAIL":
            return sendTemplate(TEMPLATE_REG_EMAIL, "AGENDAR", data);
        case "REG_PHONE":
            return sendTemplate(TEMPLATE_REG_PHONE, "AGENDAR", data);
        case "REG_EPS":
            return sendTemplate(TEMPLATE_REG_EPS, "AGENDAR", data);
        default:
            return null;
    }
}

export default async function agendarState(msg, data, context = {}) {
    const phone = context.from || "UNKNOWN";

    data = initializeGlobalSchedulingContext(data || {});

    if (data?.step) {
        msg = await normalizeAgendarMessage(msg, data.step, data);
    }

    if (!data.step) {
        data.step = "ASK_NAME";
        return {
            response:
                "Vamos a iniciar el agendamiento.\n\n¿Cuál es tu nombre completo?",
            nextState: "AGENDAR",
            data,
        };
    }

    const previousStep = PREVIOUS_STEP_BY_STEP[data.step];
    const registrationCheck =
        previousStep && looksLikeUnexpectedInput(msg)
            ? await classifyRegistrationInputAI({ message: msg, step: data.step })
            : null;

    if (
        registrationCheck?.intent === "CORRECT_PREVIOUS" &&
        registrationCheck.confidence >= 0.7
    ) {
        data.step = previousStep;
        const prompt = buildStepPrompt(previousStep, data);

        if (prompt) {
            if (prompt.response) {
                return {
                    ...prompt,
                    response: `Sin problema, corrijamos eso. 😊\n\n${prompt.response}`,
                };
            }

            try {
                await sendWhatsAppMessage(
                    phone,
                    "Sin problema, vamos a corregir eso. 😊",
                );
            } catch (error) {
                console.error(
                    "❌ No fue posible enviar el aviso de corrección:",
                    error,
                );
            }

            return prompt;
        }
    }

    switch (data.step) {
        case "ASK_NAME": {
            if (isMenuEscapePhrase(msg)) return returnToMenu();

            if (!isValidFullName(msg) || !hasAtLeastTwoWords(msg)) {
                const aiFallback = await resolveFlowFallback({
                    message: msg,
                    currentState: "AGENDAR",
                    currentStep: data.step,
                    data,
                    context,
                });
                if (aiFallback) return aiFallback;

                return {
                    response: !isValidFullName(msg)
                        ? "😊 No pude reconocer tu nombre.\n\n" +
                          "Por favor, escribe tu nombre completo. Por ejemplo: Juan Pérez."
                        : "😊 Necesito tu nombre completo, con al menos un apellido.\n\n" +
                          "Por favor, escríbelo así: Juan Pérez.",
                    nextState: "AGENDAR",
                    data,
                };
            }

            data.fullName = capitalize(msg);
            const split = splitName(data.fullName);
            data.firstName = capitalize(split.firstName);

            try {
                await upsertPatientName(phone, data.fullName);
            } catch { }

            data.step = "ASK_DOC_TYPE";
            return sendDocTypeTemplate(data);
        }

        case "ASK_DOC_TYPE": {
            if (msg === "0") return returnToMenu();

            const t = normalizeDocType(msg);
            if (!t) {
                return sendDocTypeTemplate(data);
            }

            data.patientDocumentType = t;
            data.step = "ASK_DOC_NUMBER";
            return sendTemplate(TEMPLATE_REG_DOCUMENT_NUMBER, "AGENDAR", data);
        }

        case "ASK_DOC_NUMBER": {
            if (msg === "0") return returnToMenu();

            const doc = normalizeDocumentDigits(msg);
            if (!/^\d{5,20}$/.test(doc)) {
                const aiFallback = await resolveFlowFallback({
                    message: msg,
                    currentState: "AGENDAR",
                    currentStep: data.step,
                    data,
                    context,
                });
                if (aiFallback) return aiFallback;

                return {
                    response:
                        "😊 Parece que el número de documento no tiene el formato esperado.\n\n" +
                        "Por favor, escríbelo nuevamente usando solo números y mínimo 5 dígitos.\n\n" +
                        "0️⃣ Volver al menú",
                    nextState: "AGENDAR",
                    data,
                };
            }

            data.patientDocumentType = Number(data.patientDocumentType);
            data.patientDocumentNumber = doc;

            try {
                const local = await findSaludtoolsPatientInDb({
                    docType: data.patientDocumentType,
                    docNum: data.patientDocumentNumber,
                });

                if (local) {
                    data.patientExistsLocal = true;
                    data.patientStatus = "ACTIVE";
                    data.step = "ASK_DATE";

                    if (data.pendingDateInput) {
                        const pendingDateInput = data.pendingDateInput;
                        delete data.pendingDateInput;
                        return agendarState(pendingDateInput, data, context);
                    }

                    return {
                        response:
                            `Perfecto${data.firstName ? `, ${data.firstName}` : ""}, ya encontré tu registro.\n\n` +
                            buildAskDateMessage(),
                        nextState: "AGENDAR",
                        data,
                    };
                }
            } catch (e) {
                if (SALUDTOOLS_DEBUG) {
                    console.error("findSaludtoolsPatientInDb error", e);
                }
            }

            data.patientExistsLocal = false;

            const parts = splitName(data.fullName || "");
            data.regPatient = {
                firstName: parts.firstName || "",
                secondName: parts.secondName || "",
                firstLastName: parts.firstLastName || "",
                secondLastName: parts.secondLastName || "",
                birthDate: "",
                gender: null,
                email: "",
                phone: "",
                eps: "",
                habeasData: false,
            };

            data.step = "REG_CONFIRM_NAMES";
            return sendTemplate(TEMPLATE_REG_CONFIRM_NAMES, "AGENDAR", data, {
                "1": capitalize(data.regPatient.firstName) || "(vacío)",
                "2": capitalize(data.regPatient.secondName) || "(vacío)",
                "3": capitalize(data.regPatient.firstLastName) || "(vacío)",
                "4": capitalize(data.regPatient.secondLastName) || "(vacío)",
            });
        }

        case "REG_CONFIRM_NAMES": {
            if (msg === "0") return returnToMenu();

            if (msg === "1") {
                data.step = "REG_BIRTHDATE";
                return sendTemplate(TEMPLATE_REG_BIRTHDATE, "AGENDAR", data);
            }

            if (msg === "2") {
                data.step = "REG_FIRSTNAME";
                return sendTemplate(TEMPLATE_REG_FIRSTNAME, "AGENDAR", data);
            }

            const aiFallback = await resolveFlowFallback({
                message: msg,
                currentState: "AGENDAR",
                currentStep: data.step,
                data,
                context,
            });
            if (aiFallback) return aiFallback;

            return {
                response: "Responde 1, 2 o 0.",
                nextState: "AGENDAR",
                data,
            };
        }

        case "REG_FIRSTNAME": {
            if (isMenuEscapePhrase(msg)) return returnToMenu();
            const v = String(msg || "").trim();

            if (!isValidFullName(v, 2)) {
                const aiFallback = await resolveFlowFallback({
                    message: msg,
                    currentState: "AGENDAR",
                    currentStep: data.step,
                    data,
                    context,
                });
                if (aiFallback) return aiFallback;

                return {
                    response:
                        "Primer nombre inválido. Escribe solo tu primer nombre, sin pegar otro texto:",
                    nextState: "AGENDAR",
                    data,
                };
            }

            data.regPatient.firstName = capitalize(v);
            data.step = "REG_SECONDNAME";
            return sendTemplate(TEMPLATE_REG_SECONDNAME, "AGENDAR", data);
        }

        case "REG_SECONDNAME": {
            if (isNoSecondNamePhrase(msg)) {
                data.regPatient.secondName = "";
            } else if (isMenuEscapePhrase(msg)) {
                return returnToMenu();
            } else if (isValidFullName(msg, 2)) {
                data.regPatient.secondName = capitalize(msg);
            } else {
                const aiFallback = await resolveFlowFallback({
                    message: msg,
                    currentState: "AGENDAR",
                    currentStep: data.step,
                    data,
                    context,
                });
                if (aiFallback) return aiFallback;

                return {
                    response:
                        "No reconocí eso como un nombre. Escribe tu segundo nombre, o 0 si no tienes:",
                    nextState: "AGENDAR",
                    data,
                };
            }

            data.step = "REG_FIRSTLASTNAME";
            return { response: "Primer apellido:", nextState: "AGENDAR", data };
        }

        case "REG_FIRSTLASTNAME": {
            if (isMenuEscapePhrase(msg)) return returnToMenu();
            const v = String(msg || "").trim();
            if (!isValidFullName(v, 2)) {
                const aiFallback = await resolveFlowFallback({
                    message: msg,
                    currentState: "AGENDAR",
                    currentStep: data.step,
                    data,
                    context,
                });
                if (aiFallback) return aiFallback;

                return {
                    response:
                        "Apellido inválido. Escribe solo tu primer apellido, sin pegar otro texto:",
                    nextState: "AGENDAR",
                    data,
                };
            }

            data.regPatient.firstLastName = capitalize(v);
            data.step = "REG_SECONDLASTNAME";
            return {
                response: "Segundo apellido (si no tienes, escribe 0):",
                nextState: "AGENDAR",
                data,
            };
        }

        case "REG_SECONDLASTNAME": {
            if (isNoSecondNamePhrase(msg)) {
                data.regPatient.secondLastName = "";
            } else if (isMenuEscapePhrase(msg)) {
                return returnToMenu();
            } else if (isValidFullName(msg, 2)) {
                data.regPatient.secondLastName = capitalize(msg);
            } else {
                const aiFallback = await resolveFlowFallback({
                    message: msg,
                    currentState: "AGENDAR",
                    currentStep: data.step,
                    data,
                    context,
                });
                if (aiFallback) return aiFallback;

                return {
                    response:
                        "No reconocí eso como un apellido. Escribe tu segundo apellido, o 0 si no tienes:",
                    nextState: "AGENDAR",
                    data,
                };
            }

            data.step = "REG_BIRTHDATE";
            return sendTemplate(TEMPLATE_REG_BIRTHDATE, "AGENDAR", data);
        }

        case "REG_BIRTHDATE": {
            if (msg === "0") return returnToMenu();

            const v = normalizeBirthDateInput(msg);
            if (!isValidBirthDateYmd(v)) {
                return {
                    response:
                        "Fecha inválida. Usa YYYY-MM-DD. Ej: 1967-12-05\n" +
                        "También puedes escribirla como DD/MM/YYYY. Ej: 05/12/1967",
                    nextState: "AGENDAR",
                    data,
                };
            }

            data.regPatient.birthDate = v;
            data.step = "REG_GENDER";
            return sendTemplate(TEMPLATE_REG_GENDER, "AGENDAR", data);
        }

        case "REG_GENDER": {
            if (msg === "0") return returnToMenu();

            // Antes solo se aceptaba "1"/"2" literal (los botones de la
            // plantilla): escribir "femenino"/"masculino" en texto libre,
            // muy natural para esta pregunta, no funcionaba porque la IA de
            // navegación no interpreta valores de un paso, solo intención de
            // cambiar de flujo.
            const genderKey = normKey(msg);
            const genderValue =
                msg === "1" ||
                ["masculino", "hombre", "varon"].includes(genderKey)
                    ? 1
                    : msg === "2" || ["femenino", "mujer"].includes(genderKey)
                      ? 2
                      : null;

            if (!genderValue) {
                const aiFallback = await resolveFlowFallback({
                    message: msg,
                    currentState: "AGENDAR",
                    currentStep: data.step,
                    data,
                    context,
                });
                if (aiFallback) return aiFallback;

                return {
                    response: "Elige 1 o 2, o 0 para volver al menú.",
                    nextState: "AGENDAR",
                    data,
                };
            }

            data.regPatient.gender = genderValue;
            data.step = "REG_EMAIL";
            return sendTemplate(TEMPLATE_REG_EMAIL, "AGENDAR", data);
        }

        case "REG_EMAIL": {
            if (msg === "0") data.regPatient.email = "";
            else {
                const em = normalizeEmail(msg);
                if (em === null) {
                    const aiFallback = await resolveFlowFallback({
                        message: msg,
                        currentState: "AGENDAR",
                        currentStep: data.step,
                        data,
                        context,
                    });
                    if (aiFallback) return aiFallback;

                    return {
                        response:
                            "Correo inválido. Intenta de nuevo o escribe 0:",
                        nextState: "AGENDAR",
                        data,
                    };
                }
                data.regPatient.email = em;
            }

            data.step = "REG_PHONE";
            return sendTemplate(TEMPLATE_REG_PHONE, "AGENDAR", data);
        }

        case "REG_PHONE": {
            if (msg === "0") return returnToMenu();

            const phone = String(msg || "").replace(/\D/g, "");

            if (!/^\d{7,15}$/.test(phone)) {
                const aiFallback = await resolveFlowFallback({
                    message: msg,
                    currentState: "AGENDAR",
                    currentStep: data.step,
                    data,
                    context,
                });
                if (aiFallback) return aiFallback;

                return {
                    response:
                        "Número inválido. Escribe únicamente números (entre 7 y 15 dígitos).\n\n" +
                        "0️⃣ Volver al menú",
                    nextState: "AGENDAR",
                    data,
                };
            }

            data.regPatient.phone = phone;

            data.step = "REG_EPS";

            return sendTemplate(TEMPLATE_REG_EPS, "AGENDAR", data);
        }

        case "REG_EPS": {
            const v = normKey(msg);

            if (v === "0") {
                data.regPatient.eps = 0;
                data.regPatient.epsName = "";
                data.regPatient.isParticular = true;
            } else if (v === "particular" || v === "no aplica") {
                data.regPatient.eps = 0;
                data.regPatient.epsName = "PARTICULAR";
                data.regPatient.isParticular = true;
            } else if (EPS_CONVENIO[v]) {
                data.regPatient.eps = EPS_CONVENIO[v].id;
                data.regPatient.epsName = EPS_CONVENIO[v].label;
                data.regPatient.isParticular = false;
            } else {
                data.regPatient.eps = 0;
                data.regPatient.epsName = msg;
                data.regPatient.isParticular = true;
            }

            data.step = "REG_HABEAS";
            return sendTemplate(TEMPLATE_REG_HABEAS, "AGENDAR", data);
        }

        case "REG_HABEAS": {
            if (msg === "0") return returnToMenu();

            // Mismo caso que REG_GENDER: "sí, autorizo"/"acepto" en texto
            // libre es la forma más natural de responder esta pregunta, y
            // antes solo el "1"/"2" literal del botón funcionaba.
            const habeasKey = normKey(msg);
            const habeasValue =
                msg === "1" ||
                ["si", "acepto", "autorizo", "de acuerdo"].includes(habeasKey)
                    ? 1
                    : msg === "2" ||
                        ["no", "no acepto", "no autorizo"].includes(habeasKey)
                      ? 2
                      : null;

            if (!habeasValue) {
                const aiFallback = await resolveFlowFallback({
                    message: msg,
                    currentState: "AGENDAR",
                    currentStep: data.step,
                    data,
                    context,
                });
                if (aiFallback) return aiFallback;

                return {
                    response: "Responde 1 o 2, o 0.",
                    nextState: "AGENDAR",
                    data,
                };
            }

            data.regPatient.habeasData = habeasValue === 1;
            data.step = "ASK_DATE";

            if (data.pendingDateInput) {
                const pendingDateInput = data.pendingDateInput;
                delete data.pendingDateInput;
                return agendarState(pendingDateInput, data, context);
            }

            return {
                response:
                    "Gracias. Continuemos con el agendamiento.\n\n" +
                    buildAskDateMessage(),
                nextState: "AGENDAR",
                data,
            };
        }

        // Compatibilidad con sesiones que quedaron guardadas antes de retirar
        // el filtro de columna. Tanto "Sí" como "No" deben continuar.
        case "FILTRO_COLUMNA": {
            if (msg === "0") return returnToMenu();

            if (msg === "1" || msg === "2") {
                data.step = "ASK_DATE";

                if (data.pendingDateInput) {
                    const pendingDateInput = data.pendingDateInput;
                    delete data.pendingDateInput;
                    return agendarState(pendingDateInput, data, context);
                }

                return {
                    response: buildAskDateMessage(),
                    nextState: "AGENDAR",
                    data,
                };
            }

            const aiFallback = await resolveFlowFallback({
                message: msg,
                currentState: "AGENDAR",
                currentStep: data.step,
                data,
                context,
            });
            if (aiFallback) return aiFallback;

            return {
                response: "Responde 1 o 2, o 0 para volver al menú.",
                nextState: "AGENDAR",
                data,
            };
        }

        case "FILTRO_CONFIRM": {
            if (msg === "0") return returnToMenu();

            if (msg === "1" || msg === "2") {
                data.step = "ASK_DATE";

                if (data.pendingDateInput) {
                    const pendingDateInput = data.pendingDateInput;
                    delete data.pendingDateInput;
                    return agendarState(pendingDateInput, data, context);
                }

                return {
                    response: buildAskDateMessage(),
                    nextState: "AGENDAR",
                    data,
                };
            }

            const aiFallback = await resolveFlowFallback({
                message: msg,
                currentState: "AGENDAR",
                currentStep: data.step,
                data,
                context,
            });
            if (aiFallback) return aiFallback;

            return {
                response: "Responde 1 o 2 para continuar, o 0 para volver al menú.",
                nextState: "AGENDAR",
                data,
            };
        }

        case "ASK_DATE": {
            if (msg === "0") return returnToMenu();

            if (msg === "ESCRIBIR_FECHA") {
                return {
                    response: buildAskDateMessage(),
                    nextState: "AGENDAR",
                    data,
                };
            }

            if (String(msg || "").startsWith("RECOMENDAR:")) {
                const preferenceMessage = String(msg).slice("RECOMENDAR:".length);

                // Si el paciente pidió una fecha exacta (ej: "el 31 de
                // agosto") junto con mañana/tarde, se le muestran TODAS las
                // horas reales de esa franja (lista paginada), no solo 3
                // curadas por IA. La recomendación de IA con máximo 3
                // opciones se reserva para pedidos sin fecha fija, donde no
                // existe "el día completo" para mostrar de una vez (ej: "lo
                // más pronto posible", "próxima semana en la tarde").
                const dayPart = detectDayPartPreference(preferenceMessage);
                const explicitWindow = getSchedulingDateWindow(preferenceMessage);
                const isExplicitSingleDate =
                    explicitWindow.end &&
                    explicitWindow.start.getTime() === explicitWindow.end.getTime();

                if (isExplicitSingleDate && dayPart !== "ANY") {
                    const ymd = dateToYmd(explicitWindow.start);

                    data.date = ymdToDateLabel(ymd);
                    data.ymd = ymd;
                    data.page = 0;
                    data.dayPartPreference = dayPart;
                    data.aiRecommendations = [];

                    try {
                        const booked = await getBookedHmFromDb({
                            ymd,
                            doctorDoc: DOCTOR_DOCUMENT_NUMBER,
                        });
                        data.bookedHm = Array.isArray(booked) ? booked : [];
                    } catch (e) {
                        data.bookedHm = [];
                        if (SALUDTOOLS_DEBUG) {
                            console.error("DB booked slots error:", e);
                        }
                    }

                    data.step = "ASK_TIME";
                    return buildTimeResponse(data);
                }

                return buildRecommendedAppointmentResponse(preferenceMessage, data);
            }

            if (/^[1-3]$/.test(String(msg || "")) && data.aiRecommendations?.length) {
                const selected = data.aiRecommendations[Number(msg) - 1];
                if (!selected) {
                    return {
                        response:
                            "Selecciona una de las opciones recomendadas disponibles o escribe una fecha en formato DD/MM.",
                        nextState: "AGENDAR",
                        data,
                    };
                }

                let bookedNow = false;
                try {
                    bookedNow = await isSlotBookedInDb({
                        ymd: selected.ymd,
                        hm: selected.time,
                        doctorDoc: DOCTOR_DOCUMENT_NUMBER,
                    });
                } catch (error) {
                    if (SALUDTOOLS_DEBUG) {
                        console.error("DB recommended slot check error:", error);
                    }
                }

                if (bookedNow) {
                    data.aiRecommendations = [];
                    return {
                        response:
                            "La opción recomendada acaba de ocuparse. Escribe RECOMENDAR para consultar nuevas alternativas o ingresa otra fecha en formato DD/MM.",
                        nextState: "AGENDAR",
                        data,
                    };
                }

                data.date = selected.date;
                data.ymd = selected.ymd;
                data.time = selected.time;
                data.page = 0;
                data.aiRecommendationSelected = true;
                data.step = "ASK_TYPE";

                return sendTemplate(TEMPLATE_ASK_ATTENTION_TYPE, "AGENDAR", data);
            }

            if (isTooSoonDateRequest(msg)) {
                try {
                    await sendWhatsAppMessage(
                        phone,
                        "Esa fecha está muy cerca 😊\n\n" +
                            "Recuerda que las citas deben agendarse con mínimo 2 días de anticipación.\n\n" +
                            "No te preocupes, voy a buscar las opciones disponibles más próximas para ti 👇"
                    );
                } catch (error) {
                    console.error(
                        "❌ No fue posible enviar el aviso de anticipación:",
                        error
                    );
                }

                return buildRecommendedAppointmentResponse(
                    "lo más pronto posible",
                    data
                );
            }

            if (!isValidDateDDMM(msg)) {
                const aiFallback = await resolveFlowFallback({
                    message: msg,
                    currentState: "AGENDAR",
                    currentStep: data.step,
                    data,
                    context,
                });
                if (aiFallback) return aiFallback;

                return {
                    response:
                        "😊 Esa fecha no está disponible para agendamiento.\n\n" +
                        "Recuerda que las citas deben solicitarse con mínimo 2 días de anticipación.\n\n" +
                        "Por favor, intenta con otra fecha.",
                    nextState: "AGENDAR",
                    data,
                };
            }

            data.date = msg;
            data.ymd = ddmmToYmd(msg);
            data.page = 0;
            data.aiRecommendations = [];
            data.dayPartPreference = null;

            try {
                const booked = await getBookedHmFromDb({
                    ymd: data.ymd,
                    doctorDoc: DOCTOR_DOCUMENT_NUMBER,
                });
                data.bookedHm = Array.isArray(booked) ? booked : [];
            } catch (e) {
                data.bookedHm = [];
                if (SALUDTOOLS_DEBUG) {
                    console.error("DB booked slots error:", e);
                }
            }

            data.step = "ASK_TIME";
            return buildTimeResponse(data);
        }

        case "ASK_TIME": {
            if (msg === "0") return returnToMenu();

            if (String(msg || "").startsWith("RECOMENDAR:")) {
                const preferenceMessage = String(msg).slice("RECOMENDAR:".length);

                // Ya se conoce una fecha (se llegó aquí después de elegirla),
                // pero el paciente puede estar pidiendo una fecha DISTINTA en
                // el mismo mensaje (ej: "el 1 de septiembre por la mañana
                // entonces" después de que el 5 no tuvo cupo). Antes esto se
                // ignoraba por completo y se seguía mostrando la fecha vieja.
                const explicitWindow = getSchedulingDateWindow(preferenceMessage);
                const isExplicitSingleDate =
                    explicitWindow.end &&
                    explicitWindow.start.getTime() === explicitWindow.end.getTime();

                if (isExplicitSingleDate) {
                    const ymd = dateToYmd(explicitWindow.start);
                    data.date = ymdToDateLabel(ymd);
                    data.ymd = ymd;

                    try {
                        const booked = await getBookedHmFromDb({
                            ymd,
                            doctorDoc: DOCTOR_DOCUMENT_NUMBER,
                        });
                        data.bookedHm = Array.isArray(booked) ? booked : [];
                    } catch (e) {
                        data.bookedHm = [];
                        if (SALUDTOOLS_DEBUG) {
                            console.error("DB booked slots error:", e);
                        }
                    }
                }

                // Si el paciente pide "en la mañana"/"en la tarde", se le
                // muestran TODAS las horas reales de esa franja para ese
                // día, no solo 3 curadas por IA.
                const dayPart = detectDayPartPreference(preferenceMessage);
                if (dayPart !== "ANY") {
                    data.page = 0;
                    data.dayPartPreference = dayPart;
                    return buildTimeResponse(data);
                }

                return buildRecommendedTimeResponse(preferenceMessage, data);
            }

            if (
                /^[1-3]$/.test(String(msg || "")) &&
                data.aiTimeRecommendationActive &&
                data.aiTimeRecommendations?.length
            ) {
                const selected = data.aiTimeRecommendations[Number(msg) - 1];
                if (!selected) {
                    return {
                        response:
                            "Selecciona una de las opciones recomendadas o escribe otra fecha en formato DD/MM.",
                        nextState: "AGENDAR",
                        data,
                    };
                }

                let bookedNow = false;
                try {
                    bookedNow = await isSlotBookedInDb({
                        ymd: selected.ymd,
                        hm: selected.time,
                        doctorDoc: DOCTOR_DOCUMENT_NUMBER,
                    });
                } catch (error) {
                    if (SALUDTOOLS_DEBUG) {
                        console.error("DB AI time slot check error:", error);
                    }
                }

                if (bookedNow) {
                    data.aiTimeRecommendations = [];
                    data.aiTimeRecommendationActive = false;
                    return {
                        response:
                            "😊 Parece que ese horario acaba de ser ocupado.\n\n" +
                            "No te preocupes, puedo ayudarte a encontrar otra opción disponible.",
                        nextState: "AGENDAR",
                        data,
                    };
                }

                data.time = selected.time;
                data.aiTimeRecommendationActive = false;
                data.step = "ASK_TYPE";
                return sendTemplate(TEMPLATE_ASK_ATTENTION_TYPE, "AGENDAR", data);
            }

            if (isValidDateDDMM(msg)) {
                data.date = msg;
                data.ymd = ddmmToYmd(msg);
                data.page = 0;
                data.dayPartPreference = null;

                try {
                    const booked = await getBookedHmFromDb({
                        ymd: data.ymd,
                        doctorDoc: DOCTOR_DOCUMENT_NUMBER,
                    });
                    data.bookedHm = Array.isArray(booked) ? booked : [];
                } catch (e) {
                    data.bookedHm = [];
                    if (SALUDTOOLS_DEBUG) {
                        console.error("DB booked slots error:", e);
                    }
                }

                return buildTimeResponse(data);
            }

            const hourButton = parseHourButton(msg);

            if (msg === "7" || hourButton === "MORE") {
                data.page = Number(data.page || 0) + 1;
                return buildTimeResponse(data);
            }

            const slots = Array.isArray(data.visibleSlots)
                ? data.visibleSlots
                : await getSlotsForDate(data.ymd, data.page || 0);

            const index = typeof hourButton === "number" ? hourButton : Number(msg) - 1;

            if (!Number.isFinite(index) || index < 0 || index >= slots.length) {
                const aiFallback = await resolveFlowFallback({
                    message: msg,
                    currentState: "AGENDAR",
                    currentStep: data.step,
                    data,
                    context,
                });
                if (aiFallback) return aiFallback;

                // La plantilla de horarios siempre muestra 6 casillas (es una
                // lista de WhatsApp aprobada con tamaño fijo); cuando hay menos
                // horas reales, las sobrantes se rellenan con un texto de
                // relleno, pero siguen siendo tocables. Si el paciente tocó una
                // de esas (hourButton reconocido pero fuera de rango), el
                // mensaje debe ser claro sobre por qué no pasó nada, en vez del
                // genérico "elige una opción válida" que suena a que escribió
                // cualquier cosa.
                const tappedEmptySlot =
                    typeof hourButton === "number" && hourButton >= slots.length;

                return {
                    response: tappedEmptySlot
                        ? `Ese horario no está disponible para ${data.date}.\n\n` +
                          "Por favor elige una de las horas que sí aparecen en la lista, o escribe \"más horarios\" para ver otras opciones.\n\n" +
                          "0️⃣ Volver al menú"
                        : `Elige una opción válida (1 a ${slots.length}).\n\n` +
                          "También puedes escribir otra fecha en formato DD/MM.\n\n" +
                          "O escribe ‘recomiéndame en la mañana’ o ‘recomiéndame en la tarde’.\n\n" +
                          "Pulsa Más horarios para ver más opciones.\n" +
                          "0️⃣ Volver al menú",
                    nextState: "AGENDAR",
                    data,
                };
            }

            const hour = slots[index];

            let bookedNow = false;
            try {
                bookedNow = await isSlotBookedInDb({
                    ymd: data.ymd,
                    hm: hour,
                    doctorDoc: DOCTOR_DOCUMENT_NUMBER,
                });
            } catch (e) {
                bookedNow = false;
                if (SALUDTOOLS_DEBUG) {
                    console.error("DB slot check error:", e);
                }
            }

            if (bookedNow) {
                data.bookedHm = Array.isArray(data.bookedHm)
                    ? data.bookedHm
                    : [];
                if (!data.bookedHm.includes(hour)) data.bookedHm.push(hour);

                const ui = await buildTimeResponse(data);
                return {
                    ...ui,
                    response:
                        "El horario seleccionado ya no se encuentra disponible.\n" +
                        "Por favor elige otro horario:\n\n" +
                        (ui.response || ""),
                };
            }

            data.time = hour;

            // Si en el registro de esta sesión ya dijo que no tiene EPS/es
            // particular (REG_EPS), no tiene sentido volver a preguntárselo
            // aquí con otro nombre ("tipo de atención"). Se salta directo a
            // los costos/preparación con "Consulta particular".
            if (data.regPatient?.isParticular === true) {
                return finalizeAttentionType(data, phone, "Consulta particular");
            }

            data.step = "ASK_TYPE";

            return sendTemplate(TEMPLATE_ASK_ATTENTION_TYPE, "AGENDAR", data);
        }

        case "ASK_TYPE": {
            if (msg === "0") return returnToMenu();

            const typeKey = normKey(msg);

            if (
                msg === "1" ||
                typeKey === "consulta particular" ||
                typeKey === "particular" ||
                typeKey.includes("particular")
            ) {
                return finalizeAttentionType(data, phone, "Consulta particular");
            }

            if (
                msg === "2" ||
                typeKey.includes("poliza") ||
                typeKey.includes("prepagada") ||
                typeKey.includes("medicina prepagada")
            ) {
                return finalizeAttentionType(
                    data,
                    phone,
                    "Consulta con póliza/prepagada",
                );
            }

            {
                const aiFallback = await resolveFlowFallback({
                    message: msg,
                    currentState: "AGENDAR",
                    currentStep: data.step,
                    data,
                    context,
                });
                if (aiFallback) return aiFallback;
            }

            return sendTemplate(TEMPLATE_ASK_ATTENTION_TYPE, "AGENDAR", data);
        }

        case "SHOW_COST_INFO": {
            if (msg === "0") return returnToMenu();

            if (msg !== "1") {
                const aiFallback = await resolveFlowFallback({
                    message: msg,
                    currentState: "AGENDAR",
                    currentStep: data.step,
                    data,
                    context,
                });
                if (aiFallback) return aiFallback;

                return {
                    response:
                        "Responde 1 para continuar o 0 para volver al menú.",
                    nextState: "AGENDAR",
                    data,
                };
            }

            const appointmentId = await createProposedAppointment({
                phone,
                fullName: data.fullName,
                date: data.date,
                time: data.time,
                attentionType: data.attentionType,
                status: "QUEUED",
            });
            data.appointmentId = appointmentId;

            await logAppointmentMessage(
                appointmentId,
                "Inicio de agendamiento por bot",
            );
            await logAppointmentMessage(
                appointmentId,
                `Paciente: ${data.fullName}`,
            );
            await logAppointmentMessage(appointmentId, `Teléfono: ${phone}`);
            await logAppointmentMessage(
                appointmentId,
                `Documento tipo: ${data.patientDocumentType}`,
            );
            await logAppointmentMessage(
                appointmentId,
                `Documento número: ${data.patientDocumentNumber}`,
            );
            await logAppointmentMessage(
                appointmentId,
                `Fecha: ${data.date} | Hora: ${data.time}`,
            );
            await logAppointmentMessage(
                appointmentId,
                `Tipo de atención: ${data.attentionType}`,
            );
            await logAppointmentMessage(
                appointmentId,
                `Modalidad solicitada: ${data.consultationMode || "PRESENCIAL"}`,
            );
            await logAppointmentMessage(
                appointmentId,
                "Solicitud encolada para procesamiento completo en worker",
            );

            const ymd = data.ymd || ddmmToYmd(data.date);
            const appointmentModality =
                data.consultationMode === "TELECONSULTA"
                    ? process.env.SALUDTOOLS_TELECONSULTATION_MODALITY ||
                      APPOINTMENT_MODALITY
                    : APPOINTMENT_MODALITY;
            const end = addMinutesToYmdHm(
                ymd,
                data.time,
                APPOINTMENT_DURATION_MIN,
            );

            let patientBody = null;

            if (!data.patientExistsLocal) {
                const patientBodyRaw = {
                    firstName: data.regPatient?.firstName || "",
                    secondName: data.regPatient?.secondName || "",
                    firstLastName: data.regPatient?.firstLastName || "",
                    secondLastName: data.regPatient?.secondLastName || "",
                    birthDate: data.regPatient?.birthDate || "",
                    gender: Number(data.regPatient?.gender || 0),
                    documentType: Number(data.patientDocumentType),
                    documentNumber: String(data.patientDocumentNumber),
                    phone: data.regPatient.phone,
                    cellPhone: data.regPatient.phone || parsePhoneE164ToDigits(phone),
                    email: data.regPatient?.email || "",
                    eps: data.regPatient?.eps ? Number(data.regPatient.eps) : 0,
                    habeasData: Boolean(data.regPatient?.habeasData),
                };

                const checked = validateAndNormalizePatientBody(patientBodyRaw);
                if (!checked.ok) {
                    data.step = checked.step;
                    return {
                        response: checked.message,
                        nextState: "AGENDAR",
                        data,
                    };
                }

                patientBody = checked.body;
            }

            await updateAppointmentStatusById(appointmentId, "QUEUED");

            await createSaludtoolsJob({
                jobType: "APPOINTMENT_CREATE",
                phone,
                appointmentId,
                dedupeKey: `appointment:${data.patientDocumentType}:${data.patientDocumentNumber}:${ymd}:${data.time}`,
                payload: {
                    fullName: data.fullName,
                    dateLabel: data.date,
                    timeLabel: data.time,
                    patientExistsLocal: Boolean(data.patientExistsLocal),
                    patientBody,
                    appointmentBody: {
                        startAppointment: `${ymd} ${data.time}`,
                        endAppointment: `${end.ymd} ${end.hm}`,
                        patientDocumentType: Number(data.patientDocumentType),
                        patientDocumentNumber: String(
                            data.patientDocumentNumber,
                        ),
                        doctorDocumentType: DOCTOR_DOCUMENT_TYPE,
                        doctorDocumentNumber: DOCTOR_DOCUMENT_NUMBER,
                        modality: appointmentModality,
                        stateAppointment: APPOINTMENT_STATE,
                        appointmentType:
                            data.appointmentType || APPOINTMENT_TYPE_DEFAULT,
                        clinic: CLINIC_ID,
                        comment:
                            `Creada por chatbot. Paciente: ${data.fullName}. Tel: ${phone}` +
                            (data.consultationMode === "TELECONSULTA"
                                ? ". Modalidad solicitada: teleconsulta / lectura de estudios"
                                : "") +
                            (data.isPostOperative
                                ? ". Motivo: cita posoperatoria desde los 15 días posteriores a cirugía"
                                : ""),
                    },
                },
                priority: 110,
            });

            data.step = "POST_CREATED";
            return sendTemplate(TEMPLATE_SOLICITUD_REGISTRADA, "AGENDAR", data, {
                "1": data.firstName,
                "2": data.attentionType,
            });
        }

        case "POST_CREATED": {
            if (msg === "1") {
                const currentStatus = await getAppointmentStatusById(
                    data.appointmentId,
                );

                const response =
                    currentStatus === "CONFIRMED"
                        ? `Listo ${data.firstName}. Tu cita ya quedó confirmada. ✅\n\nNos vemos pronto.`
                        : currentStatus === "FAILED"
                          ? `${data.firstName}, tuvimos un inconveniente confirmando tu cita. Nuestro equipo ya está al tanto y te contactaremos por este medio.`
                          : `Listo ${data.firstName}.\n\nSeguiremos procesando tu solicitud y te avisaremos por este medio cuando quede confirmada.`;

                return {
                    response,
                    nextState: "MENU",
                    data: { renderMenu: true },
                };
            }

            if (msg === "0" || msg === "2") return returnToMenu();

            const aiFallback = await resolveFlowFallback({
                message: msg,
                currentState: "AGENDAR",
                currentStep: data.step,
                data,
                context,
            });
            if (aiFallback) return aiFallback;

            return {
                response:
                    "😊 Tu solicitud de cita ya fue registrada.\n\n" +
                    "Puedes escribir *MENÚ* para volver al inicio o decirme qué necesitas, por ejemplo: *cancelar cita* o *reagendar cita*.",
                nextState: "AGENDAR",
                data,
            };
        }

        default: {
            const aiFallback = await resolveFlowFallback({
                message: msg,
                currentState: "AGENDAR",
                currentStep: data.step || null,
                data,
                context,
            });
            if (aiFallback) return aiFallback;

            return {
                response:
                    "Vamos a iniciar el agendamiento.\n\n" +
                    "La IA podrá ayudarte a escoger entre fechas y horas verificadas como disponibles.\n\n" +
                    "¿Cuál es tu nombre completo?",
                nextState: "AGENDAR",
                data: initializeGlobalSchedulingContext({ step: "ASK_NAME" }),
            };
        }
    }
}
