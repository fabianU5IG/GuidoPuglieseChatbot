import {
    createProposedAppointment,
    logAppointmentMessage,
    upsertPatientName,
    updateAppointmentStatusById,
} from "../services/chatbot-db.service.js";
import { createSaludtoolsJob } from "../services/saludtools-jobs.service.js";
import { EPS_CONVENIO, SALUDTOOLS } from "../constants.js";
import {
    generateAppointmentPreparationTipsAI,
    normalizeAppointmentInputAI,
    recommendAppointmentOptionsAI,
} from "../services/azure.ai.services.js";
import { sendWhatsAppMessage } from "../services/whatsapp.service.js";
import { resolveFlowFallback } from "../services/flowFallback.service.js";
import { db } from "../db/mysql.js";

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
        return {
            firstName: parts[0],
            secondName: parts[1],
            firstLastName: parts[2],
            secondLastName: "",
        };
    }

    return {
        firstName: parts[0],
        secondName: parts.slice(1, parts.length - 2).join(" "),
        firstLastName: parts[parts.length - 2],
        secondLastName: parts[parts.length - 1],
    };
}

/**
 * Festivos Colombia 2026
 */
function isHoliday(ymd) {
    const holidays = [
        // 2026
        "2026-01-01", "2026-01-12", "2026-03-23", "2026-04-02", "2026-04-03",
        "2026-05-01", "2026-05-18", "2026-06-08", "2026-06-15", "2026-06-29",
        "2026-07-20", "2026-08-07", "2026-08-17", "2026-10-12", "2026-11-02",
        "2026-11-16", "2026-12-08", "2026-12-25"
    ];
    return holidays.includes(ymd);
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
    if (key === "hoy" || key === "manana") {
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

    const rows = [
        ...(Array.isArray(saludtoolsRows) ? saludtoolsRows : []),
        ...(Array.isArray(localRows) ? localRows : []),
    ].filter((row) => !isCancelledStatus(row.status));

    if (!rows.length) return [];

    const schedule = getScheduleForYmd(ymd);
    if (!schedule) return [];

    const candidateSlots = buildSlots(
        schedule.start,
        schedule.end,
        SLOT_MIN,
    );

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

function getScheduleForYmd(ymd) {
    if (isHoliday(ymd)) return null;

    const d = new Date(`${ymd}T00:00:00`);
    const dow = d.getDay();

    // Lunes (1), Martes (2), Jueves (4)
    if (dow === 1 || dow === 2 || dow === 4)
        return { start: "08:00", end: "17:30" };
    // Viernes (5)
    if (dow === 5) return { start: "08:30", end: "11:30" };

    // Miércoles (3), Sábado (6) y Domingo (0) no atiende
    return null;
}

function getSlotsForDate(ymd, page = 0) {
    const schedule = getScheduleForYmd(ymd);
    if (!schedule) return [];

    const all = buildSlots(schedule.start, schedule.end, SLOT_MIN);
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

function getSchedulingDateWindow(value) {
    const key = normKey(value);
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const minDate = addDays(today, 2);

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

    for (let offset = 0; offset < 75 && candidates.length < maxCandidates; offset += 1) {
        const date = new Date(cursor);
        date.setDate(cursor.getDate() + offset);

        if (dateWindow.end && date > dateWindow.end) break;

        const ymd = [
            date.getFullYear(),
            pad2(date.getMonth() + 1),
            pad2(date.getDate()),
        ].join("-");
        const schedule = getScheduleForYmd(ymd);
        if (!schedule) continue;

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
                buildSlots(schedule.start, schedule.end, SLOT_MIN).filter(
                    (slot) => !bookedSet.has(slot),
                ),
                message,
            ),
            preference,
        );

        // Máximo dos alternativas por fecha para mantener diversidad.
        for (const slot of freeSlots.slice(0, 2)) {
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

    const schedule = getScheduleForYmd(data.ymd);
    if (!schedule) {
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
            buildSlots(schedule.start, schedule.end, SLOT_MIN).filter(
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

function buildTimeResponse(data) {
    data.aiTimeRecommendations = [];
    data.aiTimeRecommendationActive = false;

    const ymd = data.ymd;
    const page = Number(data.page || 0);
    const slotsAll = getSlotsForDate(ymd, page);

    if (!slotsAll.length) {
        if (page > 0) {
            data.page = 0;
            return {
                response:
                    `No hay más horarios disponibles para ${data.date}.\n\n` +
                    "Puedes escribir otra fecha en formato DD/MM o seleccionar una de las horas anteriores.",
                nextState: "AGENDAR",
                data,
            };
        }

        return {
            response:
                `El Dr. no tiene atención el día ${data.date}.\n\n` +
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
        "2": slots[0] || "No disponible",
        "3": slots[1] || "No disponible",
        "4": slots[2] || "No disponible",
        "5": slots[3] || "No disponible",
        "6": slots[4] || "No disponible",
        "7": slots[5] || "No disponible",
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

    switch (data.step) {
        case "ASK_NAME": {
            if (!isValidFullName(msg)) {
                return {
                    response:
                        "No reconocí eso como un nombre válido. Por favor escribe solo tu nombre completo (ej: Juan Pérez), sin pegar otro texto:",
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

            const doc = String(msg || "").trim();
            if (!/^\d{5,20}$/.test(doc)) {
                return {
                    response:
                        "Número inválido. Por favor escribe solo números (mínimo 5 dígitos):\n\n" +
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
                            "Perfecto, ya encontré tu registro.\n\n" +
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

            return {
                response: "Responde 1, 2 o 0.",
                nextState: "AGENDAR",
                data,
            };
        }

        case "REG_FIRSTNAME": {
            if (msg === "0") return returnToMenu();
            const v = String(msg || "").trim();

            if (!isValidFullName(v, 2)) {
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
            if (msg === "0") {
                data.regPatient.secondName = "";
            } else if (isValidFullName(msg, 2)) {
                data.regPatient.secondName = capitalize(msg);
            } else {
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
            if (msg === "0") return returnToMenu();
            const v = String(msg || "").trim();
            if (!isValidFullName(v, 2)) {
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
            if (msg === "0") {
                data.regPatient.secondLastName = "";
            } else if (isValidFullName(msg, 2)) {
                data.regPatient.secondLastName = capitalize(msg);
            } else {
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

            if (msg !== "1" && msg !== "2") {
                return {
                    response: "Elige 1 o 2, o 0 para volver al menú.",
                    nextState: "AGENDAR",
                    data,
                };
            }

            data.regPatient.gender = Number(msg);
            data.step = "REG_EMAIL";
            return sendTemplate(TEMPLATE_REG_EMAIL, "AGENDAR", data);
        }

        case "REG_EMAIL": {
            if (msg === "0") data.regPatient.email = "";
            else {
                const em = normalizeEmail(msg);
                if (em === null) {
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

            if (msg !== "1" && msg !== "2") {
                return {
                    response: "Responde 1 o 2, o 0.",
                    nextState: "AGENDAR",
                    data,
                };
            }

            data.regPatient.habeasData = msg === "1";
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
                return {
                    response:
                        "❌ Fecha no válida o muy pronto.\n\n" +
                        "Ten en cuenta:\n" +
                        "• Las citas se agendan con al menos 2 días de anticipación.\n" +
                        "• No atendemos miércoles, sábados, domingos ni festivos.\n" +
                        "• Formato: DD/MM (ej: 15/05).\n\n" +
                        "Por favor, ingresa otra fecha:",
                    nextState: "AGENDAR",
                    data,
                };
            }

            data.date = msg;
            data.ymd = ddmmToYmd(msg);
            data.page = 0;
            data.aiRecommendations = [];

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
                            "La opción recomendada acaba de ocuparse. Escribe RECOMENDAR para consultar nuevas alternativas o selecciona otro horario.",
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
                : getSlotsForDate(data.ymd, data.page || 0);

            const index = typeof hourButton === "number" ? hourButton : Number(msg) - 1;

            if (!Number.isFinite(index) || index < 0 || index >= slots.length) {
                return {
                    response:
                        `Elige una opción válida (1 a ${slots.length}).\n\n` +
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

                const ui = buildTimeResponse(data);
                return {
                    ...ui,
                    response:
                        "El horario seleccionado ya no se encuentra disponible.\n" +
                        "Por favor elige otro horario:\n\n" +
                        (ui.response || ""),
                };
            }

            data.time = hour;
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
                data.attentionType = "Consulta particular";
            } else if (
                msg === "2" ||
                typeKey.includes("poliza") ||
                typeKey.includes("prepagada") ||
                typeKey.includes("medicina prepagada")
            ) {
                data.attentionType = "Consulta con póliza/prepagada";
            } else {
                return sendTemplate(TEMPLATE_ASK_ATTENTION_TYPE, "AGENDAR", data);
            }

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
                    "El Dr. atiende pacientes de las siguientes entidades:\n" +
                        "• ARL\n" +
                        "• Allianz\n" +
                        "• AXA\n" +
                        "• Colpatria\n" +
                        "• Colmedica\n" +
                        "• Colsanitas\n" +
                        "• Coomeva\n" +
                        "• Suramericana\n" +
                        "• Medisanitas\n" +
                        "• Medplus\n\n" +
                        "Si tu consulta es de manera particular, el valor es de $400.000.\n\n" +
                        "Si son controles continuos el valor puede ser menor (previa validación).\n\n" +
                        "Los descuentos son autorizados directamente por el Dr.\n\n" +
                        `${preparationLabel}\n${preparationText}\n\n` +
                        "Estas recomendaciones son administrativas y no reemplazan la valoración médica.",
                );
            } catch (error) {
                console.error("❌ No fue posible enviar el mensaje de costos/EPS:", error);
            }

            return sendTemplate(TEMPLATE_CONFIRM_CITA, "AGENDAR", data);
        }

        case "SHOW_COST_INFO": {
            if (msg === "0") return returnToMenu();

            if (msg !== "1") {
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
                return {
                    response:
                        `Listo ${data.firstName}.\n\n` +
                        "Seguiremos procesando tu solicitud y te avisaremos por este medio cuando quede confirmada.",
                    nextState: "MENU",
                    data: { renderMenu: true },
                };
            }

            if (msg === "2") return returnToMenu();
            return { response: "Responde 1 o 2.", nextState: "AGENDAR", data };
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
