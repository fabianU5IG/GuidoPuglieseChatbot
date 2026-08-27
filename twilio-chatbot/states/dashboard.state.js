import timeUtils from "../utils/time.js";
import { db } from "../db/mysql.js";
import {
    getPendingCases,
    getPendingSecretaryCases,
    resolveSecretaryCase,
    markCancelled,
    markReScheduled,
    registerChatbotInteraction,
    logAppointmentMessage,
    createSecretaryQuickAppointment,
    findSaludtoolsPatientsByName,
} from "../services/chatbot-db.service.js";
import { createSaludtoolsJob } from "../services/saludtools-jobs.service.js";
import { searchAppointmentsByPatientInSaludtools } from "../services/saludtools-api.service.js";
import { SALUDTOOLS, SECRETARY_PHONES } from "../constants.js";
import {
    parseDashboardAppointmentsAI,
    summarizeSecretaryCasesAI,
} from "../services/azure.ai.services.js";

const { getTimeSlots } = timeUtils;

/**
 * =========================
 *  CONFIG
 * =========================
 */
const SECRETARY_CASES_PAGE_SIZE = 10;
const TEMPLATE_MENU_PRINCIPAL = "HX8a87673651f780a2781725fb23872427";

const APPOINTMENT_DURATION_MIN = Number(
    process.env.SALUDTOOLS_APPOINTMENT_DURATION_MIN ||
        SALUDTOOLS.APPOINTMENT_DURATION_MIN ||
        30,
);

const DOCTOR_DOCUMENT_TYPE = Number(
    process.env.SALUDTOOLS_DOCTOR_DOCUMENT_TYPE ||
        SALUDTOOLS.DOCTOR_DOCUMENT_TYPE ||
        1,
);
const DOCTOR_DOCUMENT_NUMBER = String(
    process.env.SALUDTOOLS_DOCTOR_DOCUMENT_NUMBER ||
        SALUDTOOLS.DOCTOR_DOCUMENT_NUMBER ||
        "72134079",
);
const CLINIC_ID = Number(
    process.env.SALUDTOOLS_CLINIC_ID || SALUDTOOLS.CLINIC_ID || 18569,
);

const APPOINTMENT_MODALITY =
    process.env.SALUDTOOLS_APPOINTMENT_MODALITY || "CONVENTIONAL";
const APPOINTMENT_STATE = process.env.SALUDTOOLS_APPOINTMENT_STATE || "PENDING";

const DASHBOARD_MENU_TEXT =
    "👋 Panel de Secretaría\n\n" +
    "1️⃣ Crear cita rápida\n" +
    "2️⃣ Ver casos pendientes\n" +
    "3️⃣ Resumen IA de pendientes\n" +
    "4️⃣ Cancelar cita\n\n" +
    "0️⃣ Salir";

function returnToMainMenu() {
    return {
        response: null,
        nextState: "MENU",
        data: {},
        sendTemplate: true,
        template: {
            contentSid: TEMPLATE_MENU_PRINCIPAL,
            variables: null,
        },
    };
}

function capitalizeWords(str = "") {
    return String(str)
        .trim()
        .split(/\s+/)
        .filter(Boolean)
        .map(
            (word) =>
                word.charAt(0).toUpperCase() + word.slice(1).toLowerCase(),
        )
        .join(" ");
}

function buildFullNameFromParts(item = {}) {
    const parts = [
        item.firstName,
        item.secondName,
        item.firstLastName,
        item.secondLastName,
        item.first_name,
        item.second_name,
        item.first_last_name,
        item.second_last_name,
    ]
        .map((v) => String(v || "").trim())
        .filter(Boolean);

    return capitalizeWords(parts.join(" "));
}

function extractPatientName(item = {}) {
    const directCandidates = [
        item.fullName,
        item.patientFullName,
        item.patientName,
        item.name,
        item.full_name,
        item.patient_full_name,
        item.patient_name,
    ]
        .map((v) => String(v || "").trim())
        .filter(Boolean);

    if (directCandidates.length) {
        return capitalizeWords(directCandidates[0]);
    }

    const built = buildFullNameFromParts(item);
    if (built) return built;

    const nestedBuilt = buildFullNameFromParts(item.patient || {});
    if (nestedBuilt) return nestedBuilt;

    const nestedCandidates = [
        item.patient?.fullName,
        item.patient?.patientFullName,
        item.patient?.patientName,
        item.patient?.name,
        item.patient?.full_name,
        item.patient?.patient_full_name,
        item.patient?.patient_name,
    ]
        .map((v) => String(v || "").trim())
        .filter(Boolean);

    if (nestedCandidates.length) {
        return capitalizeWords(nestedCandidates[0]);
    }

    return "";
}

function extractPatientDocument(item = {}) {
    const candidates = [
        item.documentNumber,
        item.patientDocumentNumber,
        item.identification,
        item.cc,
        item.document_number,
        item.patient_document_number,
        item.patient?.documentNumber,
        item.patient?.patientDocumentNumber,
        item.patient?.identification,
        item.patient?.cc,
        item.patient?.document_number,
        item.patient?.patient_document_number,
    ]
        .map((v) => String(v || "").trim())
        .filter(Boolean);

    return candidates.length ? candidates[0] : "";
}

function buildPatientDisplay(item = {}) {
    const name = extractPatientName(item);
    const document = extractPatientDocument(item);

    if (name && document) return `${name} - CC ${document}`;
    if (name) return name;
    if (document) return `CC ${document}`;

    return "Paciente sin identificar";
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

function ddmmToYmd(ddmm) {
    const [day, month] = ddmm.split("/").map(Number);

    const today = new Date();
    today.setHours(0, 0, 0, 0);
    let year = today.getFullYear();

    const candidate = new Date(year, month - 1, day);

    if (candidate < today) {
        year++;
    }

    return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function isValidDateDDMM(value) {
    if (!/^\d{2}\/\d{2}$/.test(value)) return false;

    const [day, month] = value.split("/").map(Number);
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    // Igual que ddmmToYmd: si la fecha ya pasó este año, se asume el año
    // siguiente (ej. escribir "15/01" en diciembre significa el próximo
    // enero, no un enero que ya pasó).
    let year = today.getFullYear();
    let date = new Date(year, month - 1, day);
    if (date < today) {
        year++;
        date = new Date(year, month - 1, day);
    }

    return (
        !isNaN(date) &&
        date.getFullYear() === year &&
        date.getMonth() === month - 1 &&
        date.getDate() === day &&
        date >= today
    );
}
function isHoliday(ymd) {
    const holidays = [
        "2026-01-01",
        "2026-01-12",
        "2026-03-23",
        "2026-04-02",
        "2026-04-03",
        "2026-05-01",
        "2026-05-18",
        "2026-06-08",
        "2026-06-15",
        "2026-06-29",
        "2026-07-20",
        "2026-08-07",
        "2026-08-17",
        "2026-10-12",
        "2026-11-02",
        "2026-11-16",
        "2026-12-08",
        "2026-12-25",
    ];

    return holidays.includes(ymd);
}

function isValidHour(value = "") {
    return /^([01]\d|2[0-3]):([0-5]\d)$/.test(String(value).trim());
}

function mapQuickDocType(docTypeRaw = "") {
    const value = String(docTypeRaw || "")
        .trim()
        .toLowerCase();

    const map = {
        cc: 1,
        ce: 2,
        ti: 6,
    };

    return map[value] || null;
}

function normalizeQuickModality(modalityRaw = "") {
    const value = String(modalityRaw || "")
        .trim()
        .toLowerCase();

    if (value === "presencial") return "PRESENCIAL";
    if (value === "llamada") return "LLAMADA";

    return null;
}

function docTypeLabel(documentType) {
    const map = { 1: "CC", 2: "CE", 4: "Pasaporte", 5: "RC", 6: "TI" };
    return map[Number(documentType)] || "Doc";
}

// Para cuando no se encontró (o no hacía falta buscar) un paciente por
// nombre y se le pide el documento directamente a la secretaria: acepta
// "12345678", "cc 12345678", "ce 12345678", etc.
function parseQuickDocumentReply(msg) {
    const raw = String(msg || "")
        .trim()
        .toLowerCase();
    const match = raw.match(/^(cc|ce|ti)?\s*([\d.\s-]{5,25})$/);
    if (!match) return { documentType: null, documentNumber: null };

    const documentNumber = String(match[2] || "").replace(/\D/g, "");
    if (!/^\d{5,20}$/.test(documentNumber)) {
        return { documentType: null, documentNumber: null };
    }

    const documentType = mapQuickDocType(match[1] || "cc") || 1;
    return { documentType, documentNumber };
}

function parseSingleQuickAppointmentLine(line = "") {
    const raw = String(line || "")
        .trim()
        .replace(/\s+/g, " ");
    if (!raw) return null;

    const parts = raw.split(" ");
    if (parts.length !== 5) {
        return {
            ok: false,
            error: "Formato inválido. Usa: modalidad fecha hora tipoDoc numeroDoc",
            raw,
        };
    }

    const [modalityRaw, dateRaw, timeRaw, docTypeRaw, docNumberRaw] = parts;

    const modality = normalizeQuickModality(modalityRaw);
    const patientDocumentType = mapQuickDocType(docTypeRaw);
    const patientDocumentNumber = String(docNumberRaw || "").replace(/\D/g, "");

    if (!modality) {
        return {
            ok: false,
            error: "Modalidad inválida. Usa presencial o llamada",
            raw,
        };
    }

    if (!isValidDateDDMM(dateRaw)) {
        return {
            ok: false,
            error: "Fecha inválida. Usa DD/MM y una fecha vigente/futura",
            raw,
        };
    }

    if (!isValidHour(timeRaw)) {
        return {
            ok: false,
            error: "Hora inválida. Usa HH:MM",
            raw,
        };
    }

    if (!patientDocumentType) {
        return {
            ok: false,
            error: "Tipo de documento inválido. Usa cc, ce o ti",
            raw,
        };
    }

    if (patientDocumentNumber.length < 5) {
        return {
            ok: false,
            error: "Número de documento inválido",
            raw,
        };
    }

    return {
        ok: true,
        modality,
        dateLabel: dateRaw,
        timeLabel: timeRaw,
        patientDocumentType,
        patientDocumentNumber,
        rawDocType: String(docTypeRaw).trim().toLowerCase(),
        raw,
    };
}

function parseQuickAppointmentsMessage(msg = "") {
    const lines = String(msg || "")
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);

    if (!lines.length) {
        return {
            valid: [],
            invalid: [
                {
                    lineNumber: 1,
                    raw: "",
                    error: "No se recibió ninguna línea válida",
                },
            ],
        };
    }

    const valid = [];
    const invalid = [];

    lines.forEach((line, index) => {
        const parsed = parseSingleQuickAppointmentLine(line);

        if (!parsed?.ok) {
            invalid.push({
                lineNumber: index + 1,
                raw: line,
                error: parsed?.error || "Línea inválida",
            });
            return;
        }

        valid.push({
            lineNumber: index + 1,
            ...parsed,
        });
    });

    return { valid, invalid };
}

function normalizeAiDashboardAppointments(aiResult = {}) {
    const appointments = Array.isArray(aiResult.appointments)
        ? aiResult.appointments
        : [];
    const valid = [];
    const invalid = [];

    appointments.forEach((item, index) => {
        const normalizedLine = [
            String(item.modality || "").toLowerCase() === "llamada"
                ? "llamada"
                : "presencial",
            item.dateLabel,
            item.timeLabel,
            item.rawDocType ||
                (Number(item.patientDocumentType) === 2
                    ? "ce"
                    : Number(item.patientDocumentType) === 3
                      ? "ti"
                      : "cc"),
            item.patientDocumentNumber,
        ]
            .filter(Boolean)
            .join(" ");

        const parsed = parseSingleQuickAppointmentLine(normalizedLine);
        if (!parsed?.ok) {
            invalid.push({
                lineNumber: index + 1,
                raw: normalizedLine,
                error: parsed?.error || "La IA no logró estructurar esta cita",
            });
            return;
        }

        valid.push({
            lineNumber: index + 1,
            ...parsed,
        });
    });

    const aiErrors = Array.isArray(aiResult.errors) ? aiResult.errors : [];
    aiErrors.forEach((error, index) => {
        invalid.push({
            lineNumber: appointments.length + index + 1,
            raw: "IA",
            error: String(error || "Dato incompleto detectado por IA"),
        });
    });

    return { valid, invalid };
}

async function parseQuickAppointmentsMessageWithAI(msg = "") {
    const parsed = parseQuickAppointmentsMessage(msg);
    if (parsed.valid.length || !parsed.invalid.length) return parsed;

    const ai = await parseDashboardAppointmentsAI(msg);
    if (!ai) return parsed;

    // Caso "cita para fabian mañana a las 8am": la secretaria dio un nombre
    // en vez de un documento. normalizeAiDashboardAppointments más abajo
    // exige documento (arma una "línea" de 5 campos), así que esto se
    // resuelve aparte, ANTES de llegar ahí, buscando al paciente por nombre.
    if (Array.isArray(ai.appointments) && ai.appointments.length === 1) {
        const item = ai.appointments[0];
        const hasDoc = /^\d{5,20}$/.test(
            String(item.patientDocumentNumber || "").replace(/\D/g, ""),
        );
        const modality = normalizeQuickModality(item.modality) || "PRESENCIAL";

        if (
            !hasDoc &&
            item.patientName &&
            String(item.patientName).trim().length >= 2 &&
            isValidDateDDMM(item.dateLabel) &&
            isValidHour(item.timeLabel)
        ) {
            return {
                valid: [],
                invalid: [],
                pendingNameLookup: {
                    patientName: String(item.patientName).trim(),
                    modality,
                    dateLabel: item.dateLabel,
                    timeLabel: item.timeLabel,
                },
            };
        }
    }

    const aiParsed = normalizeAiDashboardAppointments(ai);
    if (!aiParsed.valid.length) return parsed;

    return {
        valid: aiParsed.valid,
        invalid: aiParsed.invalid,
        usedAI: true,
    };
}

async function createQuickAppointmentForCandidate({
    pendingAppointment,
    candidate,
}) {
    try {
        const ymd = ddmmToYmd(pendingAppointment.dateLabel);

        if (isHoliday(ymd)) {
            return {
                response:
                    "❌ Esa fecha corresponde a un festivo en Colombia. Intenta con otra fecha.\n\n" +
                    DASHBOARD_MENU_TEXT,
                nextState: "DASHBOARD",
                data: { step: "MENU" },
            };
        }

        const result = await createSecretaryQuickAppointment({
            date: ymd,
            time: pendingAppointment.timeLabel,
            durationMinutes: APPOINTMENT_DURATION_MIN,
            patientDocumentType: Number(candidate.document_type),
            patientDocumentNumber: String(candidate.document_number),
            modality: pendingAppointment.modality,
        });

        return {
            response:
                `✅ ${result.created ? "Cita creada" : "Ya existía esa cita"} para ` +
                `${candidate.full_name} (${docTypeLabel(candidate.document_type)} ${candidate.document_number}) ` +
                `el ${pendingAppointment.dateLabel} a las ${pendingAppointment.timeLabel} ` +
                `(${String(pendingAppointment.modality).toLowerCase()}).\n\n` +
                DASHBOARD_MENU_TEXT,
            nextState: "DASHBOARD",
            data: { step: "MENU" },
        };
    } catch (error) {
        return {
            response:
                `❌ No fue posible crear la cita: ${String(error?.message || error).slice(0, 180)}\n\n` +
                DASHBOARD_MENU_TEXT,
            nextState: "DASHBOARD",
            data: { step: "MENU" },
        };
    }
}

async function resolveQuickAppointmentPatientName({ pendingAppointment, data }) {
    let candidates = [];
    try {
        candidates = await findSaludtoolsPatientsByName(
            pendingAppointment.patientName,
        );
    } catch (error) {
        console.error("❌ Error buscando paciente por nombre:", error);
    }

    if (candidates.length === 1) {
        return createQuickAppointmentForCandidate({
            pendingAppointment,
            candidate: candidates[0],
        });
    }

    if (candidates.length > 1) {
        const lines = candidates
            .map(
                (c, idx) =>
                    `${idx + 1}️⃣ ${c.full_name} — ${docTypeLabel(c.document_type)} ${c.document_number}`,
            )
            .join("\n");

        return {
            response:
                `😊 Encontré varios pacientes llamados "${pendingAppointment.patientName}":\n\n` +
                `${lines}\n\n` +
                "Responde con el número de la lista, o escribe directamente el documento si ya lo tienes a la mano.\n\n" +
                "0️⃣ Cancelar",
            nextState: "DASHBOARD",
            data: {
                ...data,
                step: "QUICK_SELECT_PATIENT",
                pendingAppointment,
                patientCandidates: candidates,
            },
        };
    }

    return {
        response:
            `😊 No encontré ningún paciente registrado con el nombre "${pendingAppointment.patientName}".\n\n` +
            "Envíame su número de documento para crear la cita (ej: 12345678). " +
            "Si no es cédula, escribe el tipo adelante: \"ce 12345678\" o \"ti 12345678\".\n\n" +
            "0️⃣ Cancelar",
        nextState: "DASHBOARD",
        data: {
            ...data,
            step: "QUICK_ASK_DOCUMENT",
            pendingAppointment,
        },
    };
}

function isExitQuickBulkCommand(value = "") {
    const normalized = String(value || "")
        .trim()
        .toLowerCase();
    return ["0", "fin", "finalizar", "salir", "menu", "menú"].includes(
        normalized,
    );
}

function paginateCases(
    cases = [],
    page = 0,
    pageSize = SECRETARY_CASES_PAGE_SIZE,
) {
    const safePage = Math.max(0, Number(page || 0));
    const start = safePage * pageSize;
    const end = start + pageSize;

    return {
        items: cases.slice(start, end),
        page: safePage,
        pageSize,
        total: cases.length,
        hasNext: end < cases.length,
        hasPrev: safePage > 0,
        totalPages: Math.ceil(cases.length / pageSize),
        start,
        end,
    };
}

function toEmojiNumber(value) {
    const map = {
        0: "0️⃣",
        1: "1️⃣",
        2: "2️⃣",
        3: "3️⃣",
        4: "4️⃣",
        5: "5️⃣",
        6: "6️⃣",
        7: "7️⃣",
        8: "8️⃣",
        9: "9️⃣",
    };

    return String(value)
        .split("")
        .map((char) => map[char] || char)
        .join("");
}

const SECRETARY_CASE_REASON_LABELS = {
    POST_SURGERY_IMAGE: "📸 Foto postoperatoria para revisión",
    POST_SURGERY_SUPPORT: "🩺 Soporte postquirúrgico",
};

function formatCaseLine(c, absoluteIndex) {
    const emojiIndex = toEmojiNumber(absoluteIndex + 1);

    if (c.case_type === "SECRETARY_CASE") {
        return (
            `${emojiIndex} ${buildPatientDisplay(c)}\n` +
            `${SECRETARY_CASE_REASON_LABELS[c.reason] || c.reason || "Solicitud"}\n` +
            `${c.note ? `📝 ${c.note}\n` : ""}\n`
        );
    }

    const when =
        c.date || c.time
            ? `🗓️ ${c.date || "Sin fecha"} ${c.time || ""}`.trim()
            : "🗓️ Sin fecha";

    return (
        `${emojiIndex} ${buildPatientDisplay(c)}\n` +
        `${when}\n` +
        `Estado Saludtools: ${c.status || "N/A"}\n` +
        `${c.internal_status ? `Estado local: ${c.internal_status}\n` : ""}\n`
    );
}

function dashboardHeader() {
    return "📋 Dashboard Secretaría\n\n";
}

function buildPendingCasesResponse(cases = [], page = 0, extra = "") {
    const paginated = paginateCases(cases, page);

    if (!paginated.items.length) {
        return {
            response:
                (extra ? `${extra}\n\n` : "") +
                dashboardHeader() +
                "No hay casos pendientes.\n\n0️⃣ Salir",
            nextState: "DASHBOARD",
            data: { step: "INBOX", page: 0, cases: [] },
        };
    }

    let response = extra
        ? `${extra}\n\n📋 Casos pendientes (${paginated.total} en total):\n\n`
        : `📋 Casos pendientes (${paginated.total} en total):\n\n`;

    paginated.items.forEach((c, i) => {
        response += formatCaseLine(c, paginated.start + i);
    });

    response += `Página ${paginated.page + 1} de ${Math.max(
        1,
        paginated.totalPages,
    )}\n`;

    if (paginated.hasNext) {
        response += "\n1️⃣1️⃣ Ver más casos";
    }

    if (paginated.hasPrev) {
        response += "\n1️⃣2️⃣ Ver casos anteriores";
    }

    response +=
        "\n\nSelecciona un caso por su número global o escribe 0️⃣ para salir";

    return {
        response,
        nextState: "DASHBOARD",
        data: { step: "SELECT_CASE", cases, page: paginated.page },
    };
}

// Une las citas pendientes (Saludtools) con los casos de secretaría que no
// son una cita (foto postoperatoria, soporte general) en una sola lista, con
// case_type para saber cuáles acciones mostrar cuando se seleccione uno.
async function getAllPendingCases() {
    let appointmentCases = [];
    try {
        appointmentCases = await getPendingCases();
    } catch (err) {
        console.error("❌ Error getPendingCases:", err);
    }

    let secretaryCases = [];
    try {
        secretaryCases = await getPendingSecretaryCases();
    } catch (err) {
        console.error("❌ Error getPendingSecretaryCases:", err);
    }

    const taggedAppointments = (
        Array.isArray(appointmentCases) ? appointmentCases : []
    ).map((c) => ({ ...c, case_type: "APPOINTMENT" }));

    const taggedSecretaryCases = (
        Array.isArray(secretaryCases) ? secretaryCases : []
    ).map((c) => ({
        ...c,
        case_type: "SECRETARY_CASE",
        date: null,
        time: null,
    }));

    // Los casos sin cita (foto/soporte) primero: normalmente necesitan
    // revisión más urgente que una cita que ya tiene fecha futura.
    return [...taggedSecretaryCases, ...taggedAppointments];
}

async function returnToInbox(extra = "", page = 0) {
    const cases = await getAllPendingCases();
    return buildPendingCasesResponse(cases, page, extra);
}

async function cancelSelectedCase({ from, data }) {
    const apptId = data?.selectedCase?.appointment_id || null;
    const saludId = data?.selectedCase?.saludtools_appointment_id || null;
    const patientDocType = Number(
        data?.selectedCase?.patient_document_type || 1,
    );
    const patientDocNumber = String(
        data?.selectedCase?.patient_document_number ||
            data?.selectedCase?.document_number ||
            extractPatientDocument(data?.selectedCase || {}) ||
            "",
    ).trim();

    try {
        if (apptId) {
            await markCancelled(apptId, { changedBy: "SECRETARY" });

            await registerChatbotInteraction({
                phone: from,
                appointmentId: apptId,
                appointmentData: { newStatus: "CANCELLED" },
            });

            await logAppointmentMessage(
                apptId,
                "Secretaría: marcó CANCELLED desde dashboard",
            );
        }
    } catch (err) {
        console.error("❌ Error cancelando en DB:", err);
    }

    let workerMsg = "Worker: omitido";
    try {
        if (!data?.skipSaludtools && saludId) {
            await createSaludtoolsJob({
                jobType: "APPOINTMENT_DELETE",
                phone: from,
                appointmentId: apptId || null,
                dedupeKey: `dashboard-appointment-delete:${saludId}`,
                payload: {
                    appointmentId: saludId,
                    internalAppointmentId: apptId || null,
                    documento: patientDocNumber,
                    patientDocumentType: patientDocType,
                    source: "SECRETARY_DASHBOARD",
                },
                priority: 90,
            });

            workerMsg = "Worker: solicitud de cancelación encolada ✅";

            if (apptId) {
                await logAppointmentMessage(
                    apptId,
                    "Solicitud de cancelación encolada para worker desde dashboard",
                );
            }
        } else if (!saludId) {
            workerMsg = "Worker: omitido (sin ID de Saludtools)";
        } else if (data?.skipSaludtools) {
            workerMsg = "Worker: omitido (decisión de secretaría)";
        }
    } catch (err) {
        workerMsg = "Worker: error encolando ⚠️";
        if (apptId) {
            await logAppointmentMessage(
                apptId,
                `Error encolando cancelación para worker: ${String(
                    err?.message || err,
                ).slice(0, 800)}`,
            );
        }
    }

    return {
        response:
            "❌ Cita marcada como *CANCELADA*\n\n" +
            `${workerMsg}\n\n` +
            `${apptId ? "" : "Nota: no se encontró cita local enlazada; solo se aseguró la sincronización con Saludtools.\n\n"}` +
            "1️⃣ Terminar\n" +
            "2️⃣ Volver al dashboard",
        nextState: "DASHBOARD",
        data: { step: "AFTER_ACTION" },
    };
}

function isCancelledSaludtoolsStatus(status) {
    const normalized = String(status || "").trim().toUpperCase();
    return normalized === "CANCELLED" || normalized === "CANCELED";
}

async function findUpcomingAppointmentsForPatient({
    documentType,
    documentNumber,
}) {
    const resp = await searchAppointmentsByPatientInSaludtools({
        patientDocumentType: documentType,
        patientDocumentNumber: documentNumber,
        page: 0,
        size: 19,
    });

    const content = resp?.body?.content || resp?.content || [];
    const todayYmd = new Date().toISOString().slice(0, 10);

    return (Array.isArray(content) ? content : [])
        .filter(
            (item) =>
                !isCancelledSaludtoolsStatus(item?.stateAppointment) &&
                String(item?.startAppointment || "").slice(0, 10) >= todayYmd,
        )
        .sort((a, b) =>
            String(a.startAppointment).localeCompare(String(b.startAppointment)),
        );
}

function buildCancelAppointmentPrompt(appointments) {
    const lines = appointments
        .map(
            (item, idx) =>
                `${idx + 1}️⃣ ${String(item.startAppointment).replace("T", " ")}` +
                `${item.appointmentType ? ` — ${item.appointmentType}` : ""}`,
        )
        .join("\n");

    return (
        "Estas son sus próximas citas:\n\n" +
        `${lines}\n\n` +
        "Responde con el número de la que quieres cancelar.\n\n" +
        "0️⃣ Cancelar"
    );
}

async function startCancelFlowForDocument({ documentType, documentNumber, data }) {
    let appointments = [];
    try {
        appointments = await findUpcomingAppointmentsForPatient({
            documentType,
            documentNumber,
        });
    } catch (error) {
        console.error("❌ Error buscando citas del paciente:", error);
        return {
            response:
                "⚠️ No fue posible consultar las citas de este paciente en este momento. Intenta de nuevo en unos minutos.\n\n" +
                DASHBOARD_MENU_TEXT,
            nextState: "DASHBOARD",
            data: { step: "MENU" },
        };
    }

    if (!appointments.length) {
        return {
            response:
                `😊 No encontré citas próximas para el documento ${documentNumber}.\n\n` +
                DASHBOARD_MENU_TEXT,
            nextState: "DASHBOARD",
            data: { step: "MENU" },
        };
    }

    return {
        response: buildCancelAppointmentPrompt(appointments),
        nextState: "DASHBOARD",
        data: {
            ...data,
            step: "CANCEL_SELECT_APPOINTMENT",
            cancelDocumentType: documentType,
            cancelDocumentNumber: documentNumber,
            cancelAppointments: appointments,
        },
    };
}

async function startCancelFlowForPatientName({ patientName, data }) {
    let candidates = [];
    try {
        candidates = await findSaludtoolsPatientsByName(patientName);
    } catch (error) {
        console.error("❌ Error buscando paciente por nombre:", error);
    }

    if (candidates.length === 1) {
        return startCancelFlowForDocument({
            documentType: Number(candidates[0].document_type),
            documentNumber: String(candidates[0].document_number),
            data,
        });
    }

    if (candidates.length > 1) {
        const lines = candidates
            .map(
                (c, idx) =>
                    `${idx + 1}️⃣ ${c.full_name} — ${docTypeLabel(c.document_type)} ${c.document_number}`,
            )
            .join("\n");

        return {
            response:
                `😊 Encontré varios pacientes llamados "${patientName}":\n\n` +
                `${lines}\n\n` +
                "Responde con el número de la lista, o escribe directamente el documento.\n\n" +
                "0️⃣ Cancelar",
            nextState: "DASHBOARD",
            data: {
                ...data,
                step: "CANCEL_SELECT_PATIENT",
                cancelPatientCandidates: candidates,
            },
        };
    }

    return {
        response:
            `😊 No encontré ningún paciente registrado con el nombre "${patientName}".\n\n` +
            "Escríbeme su número de documento.\n\n" +
            "0️⃣ Cancelar",
        nextState: "DASHBOARD",
        data: {
            ...data,
            step: "CANCEL_ASK_PATIENT",
        },
    };
}

export default async function dashboardState(msg, data = {}, context) {
    const from = (context?.from || "").replace(/\D/g, "");

    if (!SECRETARY_PHONES.includes(from)) {
        return {
            response: "❌ Acceso no autorizado.",
            nextState: "MENU",
            data: {},
        };
    }

    if (!data.step) {
        data.step = "MENU";
        return {
            response: DASHBOARD_MENU_TEXT,
            nextState: "DASHBOARD",
            data,
        };
    }

    switch (data.step) {
        case "MENU": {
            if (msg === "0") {
                return returnToMainMenu();
            }

            if (msg === "1") {
                data.step = "QUICK_BULK_MESSAGE";
                return {
                    response:
                        "📝 *Crear cita rápida*\n\n" +
                        "Puedes enviar *una o varias citas por mensaje*.\n" +
                        "También puedes enviar *varios mensajes seguidos*.\n\n" +
                        "Escribe *una cita por línea* con este formato:\n\n" +
                        "*presencial 15/04 08:30 cc 123456789*\n" +
                        "*llamada 15/04 09:00 ce 987654321*\n\n" +
                        "Campos por línea:\n" +
                        "1. modalidad: presencial o llamada\n" +
                        "2. fecha: DD/MM\n" +
                        "3. hora: HH:MM\n" +
                        "4. tipo documento: cc, ce o ti\n" +
                        "5. número de documento\n\n" +
                        "🤖 O si no tienes el documento a la mano, también puedes escribirlo natural, dando el nombre del paciente:\n" +
                        "_\"cita para fabian mañana a las 8am\"_\n" +
                        "Busco al paciente por nombre y te confirmo o te pregunto el documento si no lo encuentro.\n\n" +
                        "Cuando termines, escribe *fin* o *0*.",
                    nextState: "DASHBOARD",
                    data,
                };
            }

            if (msg === "2") {
                data.step = "INBOX";
                const cases = await getAllPendingCases();
                return buildPendingCasesResponse(cases, 0);
            }

            if (msg === "3") {
                const cases = await getAllPendingCases();
                const summary = await summarizeSecretaryCasesAI(cases);
                return {
                    response:
                        "🤖 Resumen IA de pendientes\n\n" +
                        (summary ||
                            "No encontré suficientes datos para generar un resumen.") +
                        "\n\n" +
                        DASHBOARD_MENU_TEXT,
                    nextState: "DASHBOARD",
                    data: { step: "MENU" },
                };
            }

            if (msg === "4") {
                data.step = "CANCEL_ASK_PATIENT";
                return {
                    response:
                        "❌ *Cancelar cita*\n\n" +
                        "¿A nombre de quién está la cita? Escribe el nombre del paciente o su número de documento.\n\n" +
                        "0️⃣ Cancelar",
                    nextState: "DASHBOARD",
                    data,
                };
            }

            return {
                response: DASHBOARD_MENU_TEXT,
                nextState: "DASHBOARD",
                data,
            };
        }

        case "QUICK_BULK_MESSAGE": {
            if (isExitQuickBulkCommand(msg)) {
                return {
                    response:
                        "✅ Saliendo de carga rápida de citas.\n\n" +
                        DASHBOARD_MENU_TEXT,
                    nextState: "DASHBOARD",
                    data: { step: "MENU" },
                };
            }

            const { valid, invalid, usedAI, pendingNameLookup } =
                await parseQuickAppointmentsMessageWithAI(msg);

            if (pendingNameLookup) {
                return resolveQuickAppointmentPatientName({
                    pendingAppointment: pendingNameLookup,
                    data,
                });
            }

            if (!valid.length) {
                let response =
                    "❌ No se pudo procesar ninguna cita.\n\n" +
                    "Formato por línea:\n" +
                    "*presencial 15/04 08:30 cc 123456789*\n" +
                    "*llamada 15/04 09:00 ce 987654321*\n\n";

                if (invalid.length) {
                    response += "Errores encontrados:\n";
                    invalid.slice(0, 10).forEach((item) => {
                        response += `Línea ${item.lineNumber}: ${item.error}\n`;
                    });
                }

                response +=
                    "\nPuedes enviar otro mensaje con más citas.\n" +
                    "Escribe *fin* o *0* para salir.";

                return {
                    response,
                    nextState: "DASHBOARD",
                    data: { ...data, step: "QUICK_BULK_MESSAGE" },
                };
            }

            const inserted = [];
            const failed = [];

            for (const item of valid) {
                try {
                    const ymd = ddmmToYmd(item.dateLabel);

                    if (isHoliday(ymd)) {
                        failed.push({
                            lineNumber: item.lineNumber,
                            raw: item.raw,
                            error: "La fecha corresponde a un festivo en Colombia",
                        });
                        continue;
                    }

                    const localResult =
                        await createSecretaryQuickAppointment({
                            date: ymd,
                            time: item.timeLabel,
                            durationMinutes: APPOINTMENT_DURATION_MIN,
                            patientDocumentType: item.patientDocumentType,
                            patientDocumentNumber:
                                item.patientDocumentNumber,
                            modality: item.modality,
                        });

                    inserted.push({
                        lineNumber: item.lineNumber,
                        id: localResult.appointmentId,
                        created: localResult.created,
                        modality: item.modality,
                        dateLabel: item.dateLabel,
                        timeLabel: item.timeLabel,
                        rawDocType: item.rawDocType,
                        patientDocumentNumber: item.patientDocumentNumber,
                    });
                } catch (err) {
                    failed.push({
                        lineNumber: item.lineNumber,
                        raw: item.raw,
                        error: String(err?.message || err).slice(0, 180),
                    });
                }
            }

            const createdCount = inserted.filter((item) => item.created).length;
            const duplicateCount = inserted.length - createdCount;

            let response =
                `✅ Guardadas en la base de datos: ${createdCount}\n` +
                `ℹ️ Ya existentes: ${duplicateCount}\n` +
                `❌ Con error: ${invalid.length + failed.length}\n\n`;

            if (inserted.length) {
                response +=
                    (usedAI ? "🤖 Interpreté el mensaje con IA.\n\n" : "") +
                    "Citas registradas localmente:\n";
                inserted.slice(0, 20).forEach((item) => {
                    response +=
                        `Línea ${item.lineNumber}: ${item.dateLabel} ${item.timeLabel} ` +
                        `${item.rawDocType.toUpperCase()} ${item.patientDocumentNumber} ` +
                        `(${item.modality})${item.created ? "" : " - ya existía"}\n`;
                });
                response += "\n";
            }

            const allErrors = [...invalid, ...failed];
            if (allErrors.length) {
                response += "Errores:\n";
                allErrors.slice(0, 20).forEach((item) => {
                    response += `Línea ${item.lineNumber}: ${item.error}\n`;
                });
                response += "\n";
            }

            response +=
                "Puedes enviar *otro mensaje* con más citas.\n" +
                "Escribe *fin* o *0* para salir.";

            return {
                response,
                nextState: "DASHBOARD",
                data: {
                    ...data,
                    step: "QUICK_BULK_MESSAGE",
                },
            };
        }

        // Se llega aquí cuando se buscó al paciente por nombre y hubo más de
        // un resultado (ej: dos pacientes llamados "Fabian").
        case "QUICK_SELECT_PATIENT": {
            if (msg === "0" || isExitQuickBulkCommand(msg)) {
                return {
                    response: "✅ Cancelado.\n\n" + DASHBOARD_MENU_TEXT,
                    nextState: "DASHBOARD",
                    data: { step: "MENU" },
                };
            }

            const candidates = Array.isArray(data.patientCandidates)
                ? data.patientCandidates
                : [];
            const selectedIndex = Number(msg);

            if (
                Number.isInteger(selectedIndex) &&
                selectedIndex >= 1 &&
                selectedIndex <= candidates.length
            ) {
                return createQuickAppointmentForCandidate({
                    pendingAppointment: data.pendingAppointment,
                    candidate: candidates[selectedIndex - 1],
                });
            }

            // También se acepta que directamente mande el documento si ya lo
            // encontró por su cuenta, en vez de elegir de la lista.
            const { documentType, documentNumber } = parseQuickDocumentReply(msg);
            if (documentNumber) {
                return createQuickAppointmentForCandidate({
                    pendingAppointment: data.pendingAppointment,
                    candidate: {
                        full_name: data.pendingAppointment?.patientName || "Paciente",
                        document_type: documentType,
                        document_number: documentNumber,
                    },
                });
            }

            return {
                response:
                    "😊 No entendí tu respuesta.\n\n" +
                    "Responde con el número de la lista, escribe el documento directamente, o 0 para cancelar.",
                nextState: "DASHBOARD",
                data,
            };
        }

        // Se llega aquí cuando NO se encontró ningún paciente con ese nombre
        // y se le pide el documento a la secretaria para crear la cita.
        case "QUICK_ASK_DOCUMENT": {
            if (msg === "0" || isExitQuickBulkCommand(msg)) {
                return {
                    response: "✅ Cancelado.\n\n" + DASHBOARD_MENU_TEXT,
                    nextState: "DASHBOARD",
                    data: { step: "MENU" },
                };
            }

            const { documentType, documentNumber } = parseQuickDocumentReply(msg);

            if (!documentNumber) {
                return {
                    response:
                        "😊 No reconocí ese documento.\n\n" +
                        "Escribe solo el número (mínimo 5 dígitos), o con el tipo adelante: \"ce 12345678\".\n\n" +
                        "0️⃣ Cancelar",
                    nextState: "DASHBOARD",
                    data,
                };
            }

            return createQuickAppointmentForCandidate({
                pendingAppointment: data.pendingAppointment,
                candidate: {
                    full_name: data.pendingAppointment?.patientName || "Paciente",
                    document_type: documentType,
                    document_number: documentNumber,
                },
            });
        }

        case "CANCEL_ASK_PATIENT": {
            if (msg === "0" || isExitQuickBulkCommand(msg)) {
                return {
                    response: "✅ Cancelado.\n\n" + DASHBOARD_MENU_TEXT,
                    nextState: "DASHBOARD",
                    data: { step: "MENU" },
                };
            }

            const directDoc = parseQuickDocumentReply(msg);
            if (directDoc.documentNumber) {
                return startCancelFlowForDocument({
                    documentType: directDoc.documentType,
                    documentNumber: directDoc.documentNumber,
                    data,
                });
            }

            const patientName = String(msg || "").trim();
            if (patientName.length < 2) {
                return {
                    response:
                        "😊 Escribe el nombre del paciente o su número de documento.\n\n0️⃣ Cancelar",
                    nextState: "DASHBOARD",
                    data,
                };
            }

            return startCancelFlowForPatientName({ patientName, data });
        }

        case "CANCEL_SELECT_PATIENT": {
            if (msg === "0" || isExitQuickBulkCommand(msg)) {
                return {
                    response: "✅ Cancelado.\n\n" + DASHBOARD_MENU_TEXT,
                    nextState: "DASHBOARD",
                    data: { step: "MENU" },
                };
            }

            const candidates = Array.isArray(data.cancelPatientCandidates)
                ? data.cancelPatientCandidates
                : [];
            const selectedIndex = Number(msg);

            if (
                Number.isInteger(selectedIndex) &&
                selectedIndex >= 1 &&
                selectedIndex <= candidates.length
            ) {
                const candidate = candidates[selectedIndex - 1];
                return startCancelFlowForDocument({
                    documentType: Number(candidate.document_type),
                    documentNumber: String(candidate.document_number),
                    data,
                });
            }

            const directDoc = parseQuickDocumentReply(msg);
            if (directDoc.documentNumber) {
                return startCancelFlowForDocument({
                    documentType: directDoc.documentType,
                    documentNumber: directDoc.documentNumber,
                    data,
                });
            }

            return {
                response:
                    "😊 No entendí tu respuesta. Responde con el número de la lista, el documento directamente, o 0 para cancelar.",
                nextState: "DASHBOARD",
                data,
            };
        }

        case "CANCEL_SELECT_APPOINTMENT": {
            if (msg === "0" || isExitQuickBulkCommand(msg)) {
                return {
                    response: "✅ Cancelado.\n\n" + DASHBOARD_MENU_TEXT,
                    nextState: "DASHBOARD",
                    data: { step: "MENU" },
                };
            }

            const appointments = Array.isArray(data.cancelAppointments)
                ? data.cancelAppointments
                : [];
            const index = Number(msg) - 1;

            if (!Number.isInteger(index) || !appointments[index]) {
                return {
                    response:
                        buildCancelAppointmentPrompt(appointments) +
                        "\n\n❌ No reconocí esa opción, intenta de nuevo.",
                    nextState: "DASHBOARD",
                    data,
                };
            }

            const chosen = appointments[index];
            return {
                response:
                    `¿Seguro que quieres cancelar la cita del ${String(chosen.startAppointment).replace("T", " ")}?\n\n` +
                    "1️⃣ Sí, cancelar\n" +
                    "2️⃣ No, dejarla como está",
                nextState: "DASHBOARD",
                data: {
                    ...data,
                    step: "CANCEL_CONFIRM",
                    cancelChosenAppointment: chosen,
                },
            };
        }

        case "CANCEL_CONFIRM": {
            if (msg !== "1") {
                return {
                    response: "✅ No se realizaron cambios.\n\n" + DASHBOARD_MENU_TEXT,
                    nextState: "DASHBOARD",
                    data: { step: "MENU" },
                };
            }

            const chosen = data.cancelChosenAppointment || {};

            return cancelSelectedCase({
                from,
                data: {
                    selectedCase: {
                        saludtools_appointment_id: chosen.id,
                        patient_document_type: data.cancelDocumentType,
                        patient_document_number: data.cancelDocumentNumber,
                    },
                },
            });
        }

        case "INBOX": {
            const cases = await getAllPendingCases();
            return buildPendingCasesResponse(cases, 0);
        }

        case "SELECT_CASE": {
            if (msg === "0") {
                return returnToMainMenu();
            }

            const allCases = Array.isArray(data.cases) ? data.cases : [];
            const currentPage = Number(data.page || 0);
            const paginated = paginateCases(allCases, currentPage);
            const raw = String(msg || "").trim();

            if (raw === "11") {
                if (!paginated.hasNext) {
                    return buildPendingCasesResponse(
                        allCases,
                        currentPage,
                        "⚠️ No hay más casos para mostrar.",
                    );
                }

                return buildPendingCasesResponse(allCases, currentPage + 1);
            }

            if (raw === "12") {
                if (!paginated.hasPrev) {
                    return buildPendingCasesResponse(
                        allCases,
                        currentPage,
                        "⚠️ Ya estás en la primera página.",
                    );
                }

                return buildPendingCasesResponse(allCases, currentPage - 1);
            }

            const requestedNumber = parseInt(raw, 10);
            const index = Number.isInteger(requestedNumber)
                ? requestedNumber - 1
                : -1;

            if (!Number.isInteger(index) || !allCases[index]) {
                return buildPendingCasesResponse(
                    allCases,
                    currentPage,
                    "❌ Opción inválida",
                );
            }

            const selectedCase = allCases[index];

            if (selectedCase.case_type === "SECRETARY_CASE") {
                const secretaryDetails =
                    `🔔 Caso seleccionado\n\n` +
                    `Paciente: ${buildPatientDisplay(selectedCase)}\n` +
                    `Motivo: ${SECRETARY_CASE_REASON_LABELS[selectedCase.reason] || selectedCase.reason || "Solicitud"}\n` +
                    `${selectedCase.note ? `Mensaje: ${selectedCase.note}\n` : ""}` +
                    `${selectedCase.media_url ? `Imagen: ${selectedCase.media_url}\n` : ""}` +
                    `Teléfono: ${selectedCase.phone || "N/A"}\n\n` +
                    "1️⃣ Marcar como atendido\n" +
                    "0️⃣ Volver";

                return {
                    response: secretaryDetails,
                    nextState: "DASHBOARD",
                    data: {
                        step: "SECRETARY_CASE_ACTIONS",
                        selectedCase,
                        cases: allCases,
                        page: currentPage,
                        inboxPage: currentPage,
                    },
                };
            }

            const details =
                `🔔 Caso seleccionado\n\n` +
                `Paciente: ${buildPatientDisplay(selectedCase)}\n` +
                `Documento: ${extractPatientDocument(selectedCase) || "N/A"}\n` +
                `Cita: ${selectedCase.date || "Sin fecha"} ${selectedCase.time || ""}\n` +
                `Estado Saludtools: ${selectedCase.status || "N/A"}\n` +
                `Estado local: ${selectedCase.internal_status || "N/A"}\n` +
                `Appointment ID local: ${selectedCase.appointment_id || "N/A"}\n` +
                `Saludtools ID: ${selectedCase.saludtools_appointment_id || "N/A"}\n\n` +
                "1️⃣ Reagendar\n" +
                "2️⃣ Cancelar\n" +
                "0️⃣ Volver";

            return {
                response: details,
                nextState: "DASHBOARD",
                data: {
                    step: "CASE_ACTIONS",
                    selectedCase,
                    cases: allCases,
                    page: currentPage,
                    // Se conserva aparte de "page" porque el flujo de
                    // reagendar reutiliza "page" para paginar horarios — sin
                    // esto, "volver al listado" desde ahí perdería la página
                    // real del listado de casos.
                    inboxPage: currentPage,
                },
            };
        }

        case "SECRETARY_CASE_ACTIONS": {
            if (msg === "0") {
                return returnToInbox(
                    "↩️ Volviendo al listado",
                    Number(data.page || 0),
                );
            }

            if (msg === "1") {
                try {
                    await resolveSecretaryCase(data?.selectedCase?.id);
                } catch (err) {
                    console.error("❌ Error marcando caso como atendido:", err);
                }

                return returnToInbox(
                    "✅ Caso marcado como atendido",
                    Number(data.inboxPage ?? data.page ?? 0),
                );
            }

            return {
                response: "❌ Opción inválida",
                nextState: "DASHBOARD",
                data,
            };
        }

        case "CASE_ACTIONS": {
            if (msg === "0") {
                return returnToInbox(
                    "↩️ Volviendo al listado",
                    Number(data.page || 0),
                );
            }

            if (msg === "1") {
                const saludId = data?.selectedCase?.saludtools_appointment_id;
                if (!saludId) {
                    return {
                        response:
                            "⚠️ Este caso no tiene *Saludtools ID*.\n\n" +
                            "Escribe el ID de Saludtools para reagendar, o escribe 0️⃣ para continuar sin actualizar en Saludtools:",
                        nextState: "DASHBOARD",
                        data: {
                            ...data,
                            step: "ASK_SALUD_ID",
                            pendingAction: "RESCHEDULE",
                        },
                    };
                }

                return {
                    response:
                        "🔄 Reagendar cita\n\nIngresa la nueva fecha (DD/MM):",
                    nextState: "DASHBOARD",
                    data: {
                        ...data,
                        step: "ASK_DATE",
                        pendingAction: "RESCHEDULE",
                        skipSaludtools: false,
                    },
                };
            }

            if (msg === "2") {
                const saludId = data?.selectedCase?.saludtools_appointment_id;
                if (!saludId) {
                    return {
                        response:
                            "⚠️ Este caso no tiene *Saludtools ID*.\n\n" +
                            "Escribe el ID de Saludtools para cancelar también en Saludtools, o escribe 0️⃣ para cancelar solo en el sistema interno:",
                        nextState: "DASHBOARD",
                        data: {
                            ...data,
                            step: "ASK_SALUD_ID",
                            pendingAction: "CANCEL",
                        },
                    };
                }

                return await cancelSelectedCase({
                    from,
                    data: { ...data, skipSaludtools: false },
                });
            }

            return {
                response: "❌ Opción inválida",
                nextState: "DASHBOARD",
                data,
            };
        }

        case "ASK_SALUD_ID": {
            const raw = String(msg || "").trim();

            if (raw === "0") {
                const next =
                    data?.pendingAction === "CANCEL" ? "DO_CANCEL" : "ASK_DATE";
                return {
                    response:
                        data?.pendingAction === "CANCEL"
                            ? "✅ Cancelando en el sistema interno... (Saludtools omitido)"
                            : "✅ Continuemos con la reprogramación... (Saludtools omitido)",
                    nextState: "DASHBOARD",
                    data: { ...data, step: next, skipSaludtools: true },
                };
            }

            const id = raw.replace(/\D/g, "");
            if (!id) {
                return {
                    response:
                        "❌ ID inválido. Escribe solo números, o 0️⃣ para omitir Saludtools:",
                    nextState: "DASHBOARD",
                    data,
                };
            }

            data.selectedCase = {
                ...(data.selectedCase || {}),
                saludtools_appointment_id: id,
            };

            const next =
                data?.pendingAction === "CANCEL" ? "DO_CANCEL" : "ASK_DATE";
            return {
                response:
                    data?.pendingAction === "CANCEL"
                        ? "✅ Cancelando en el sistema interno y Saludtools..."
                        : "✅ Continuemos con la reprogramación...",
                nextState: "DASHBOARD",
                data: { ...data, step: next, skipSaludtools: false },
            };
        }

        case "DO_CANCEL": {
            return await cancelSelectedCase({ from, data });
        }

        case "ASK_DATE": {
            if (msg === "0") {
                return returnToInbox(
                    "↩️ Volviendo al listado",
                    Number(data.inboxPage ?? data.page ?? 0),
                );
            }

            if (!isValidDateDDMM(msg)) {
                return {
                    response:
                        "❌ Fecha inválida.\nDebe ser DD/MM y futura.\n\nIntenta de nuevo:",
                    nextState: "DASHBOARD",
                    data,
                };
            }

            const ymd = ddmmToYmd(msg);

            if (isHoliday(ymd)) {
                return {
                    response:
                        "❌ La fecha seleccionada corresponde a un día festivo en Colombia.\n\nSelecciona otra fecha:",
                    nextState: "DASHBOARD",
                    data,
                };
            }

            data.newDate = msg;
            data.page = 0;
            data.step = "ASK_TIME";

            return await buildTimeResponseForDashboard(data);
        }

        case "ASK_TIME": {
            if (msg === "0") {
                return returnToInbox(
                    "↩️ Volviendo al listado",
                    Number(data.inboxPage ?? data.page ?? 0),
                );
            }

            if (msg === "7") {
                data.page++;
                return await buildTimeResponseForDashboard(data);
            }

            const index = parseInt(msg, 10) - 1;
            const slots = Array.isArray(data.availableSlots) ? data.availableSlots : [];
            const hour = slots[index];

            if (!hour) {
                return {
                    response:
                        "❌ Opción inválida. Elige un número del listado.",
                    nextState: "DASHBOARD",
                    data,
                };
            }

            data.newTime = hour;
            data.step = "CONFIRM_RESCHEDULE";

            const sel = data.selectedCase || {};
            return {
                response:
                    "✅ Confirma la reprogramación:\n\n" +
                    `Paciente: ${buildPatientDisplay(sel)}\n` +
                    `Tel: ${sel.phone || "N/A"}\n` +
                    `Nueva cita: ${data.newDate} ${data.newTime}\n\n` +
                    "1️⃣ Confirmar\n" +
                    "0️⃣ Cancelar",
                nextState: "DASHBOARD",
                data,
            };
        }

        case "CONFIRM_RESCHEDULE": {
            if (msg === "0") {
                return returnToInbox(
                    "↩️ Acción cancelada. Volviendo al listado.",
                    Number(data.inboxPage ?? data.page ?? 0),
                );
            }

            if (msg !== "1") {
                return {
                    response: "Responde 1️⃣ para confirmar o 0️⃣ para cancelar.",
                    nextState: "DASHBOARD",
                    data,
                };
            }

            const apptId = data?.selectedCase?.appointment_id || null;
            const saludId =
                data?.selectedCase?.saludtools_appointment_id || null;
            const patientDocType = Number(
                data?.selectedCase?.patient_document_type || 1,
            );
            const patientDocNumber = String(
                data?.selectedCase?.patient_document_number ||
                    data?.selectedCase?.document_number ||
                    extractPatientDocument(data?.selectedCase || {}) ||
                    "",
            ).trim();

            try {
                if (apptId) {
                    await markReScheduled(apptId, {
                        newDate: data.newDate,
                        newTime: data.newTime,
                        changedBy: "SECRETARY",
                    });

                    await registerChatbotInteraction({
                        phone: from,
                        appointmentId: apptId,
                        appointmentData: {
                            newStatus: "RESCHEDULED",
                            newDate: data.newDate,
                            newTime: data.newTime,
                        },
                    });

                    await logAppointmentMessage(
                        apptId,
                        `Secretaría: reagendó a ${data.newDate} ${data.newTime} desde dashboard`,
                    );
                }
            } catch (err) {
                console.error("❌ Error reagendando en DB:", err);
            }

            let workerMsg = "Worker: omitido";
            try {
                if (!data?.skipSaludtools && saludId) {
                    const ymd = ddmmToYmd(data.newDate);
                    const end = addMinutesToYmdHm(
                        ymd,
                        data.newTime,
                        APPOINTMENT_DURATION_MIN,
                    );

                    if (isHoliday(ymd)) {
                        return {
                            response:
                                "❌ No es posible reagendar citas para días festivos en Colombia.\n\nIngresa una nueva fecha:",
                            nextState: "DASHBOARD",
                            data: {
                                ...data,
                                step: "ASK_DATE",
                            },
                        };
                    }

                    await createSaludtoolsJob({
                        jobType: "APPOINTMENT_UPDATE",
                        phone: from,
                        appointmentId: apptId || null,
                        dedupeKey: `dashboard-appointment-update:${saludId}:${ymd}:${data.newTime}`,
                        payload: {
                            appointmentId: saludId,
                            internalAppointmentId: apptId || null,
                            documento: patientDocNumber,
                            patientDocumentType: patientDocType,
                            appointmentBody: {
                                id: String(saludId),
                                startAppointment: `${ymd} ${data.newTime}`,
                                endAppointment: `${end.ymd} ${end.hm}`,
                                patientDocumentType: patientDocType,
                                patientDocumentNumber: patientDocNumber,
                                doctorDocumentType: DOCTOR_DOCUMENT_TYPE,
                                doctorDocumentNumber: DOCTOR_DOCUMENT_NUMBER,
                                modality: APPOINTMENT_MODALITY,
                                stateAppointment: APPOINTMENT_STATE,
                                notificationState: "ATTEND",
                                appointmentType:
                                    data?.selectedCase?.attention_type ||
                                    "Cita (reprogramada por secretaría)",
                                clinic: CLINIC_ID,
                                comment: `Reprogramada por secretaría. Paciente: ${extractPatientName(
                                    data?.selectedCase || {},
                                )}`,
                            },
                            source: "SECRETARY_DASHBOARD",
                        },
                        priority: 90,
                    });

                    workerMsg =
                        "Worker: solicitud de reagendamiento encolada ✅";

                    if (apptId) {
                        await logAppointmentMessage(
                            apptId,
                            `Solicitud de reagendamiento encolada para worker: ${ymd} ${data.newTime}`,
                        );
                    }
                } else if (!saludId) {
                    workerMsg = "Worker: omitido (sin ID de Saludtools)";
                } else if (data?.skipSaludtools) {
                    workerMsg = "Worker: omitido (decisión de secretaría)";
                }
            } catch (err) {
                workerMsg = "Worker: error encolando ⚠️";
                if (apptId) {
                    await logAppointmentMessage(
                        apptId,
                        `Error encolando reagendamiento para worker: ${String(
                            err?.message || err,
                        ).slice(0, 800)}`,
                    );
                }
            }

            return {
                response:
                    "🔄 Cita marcada como *REAGENDADA*\n\n" +
                    `Nueva fecha/hora: ${data.newDate} ${data.newTime}\n\n` +
                    `${workerMsg}\n\n` +
                    `${apptId ? "" : "Nota: no se encontró cita local enlazada; se priorizó la actualización en Saludtools.\n\n"}` +
                    "1️⃣ Terminar\n" +
                    "2️⃣ Volver al dashboard",
                nextState: "DASHBOARD",
                data: { step: "AFTER_ACTION" },
            };
        }

        case "AFTER_ACTION": {
            if (msg === "1") {
                return returnToMainMenu();
            }

            if (msg === "2") {
                return {
                    response: "📋 Volviendo al dashboard...\n",
                    nextState: "DASHBOARD",
                    data: { step: "INBOX" },
                };
            }

            return {
                response: "Selecciona 1️⃣ o 2️⃣",
                nextState: "DASHBOARD",
                data,
            };
        }

        default:
            return {
                response: "⚠️ Reiniciando dashboard...",
                nextState: "DASHBOARD",
                data: { step: "INBOX" },
            };
    }
}

// Consulta las horas ya ocupadas ese día (en Saludtools o localmente) para no
// ofrecerle a la secretaría un horario que produciría un doble agendamiento.
async function getBookedTimesForYmd(ymd) {
    const [saludtoolsRows] = await db.query(
        `SELECT start_time, status FROM saludtools_appointments
         WHERE start_date = ? AND doctor_document_number = ?`,
        [ymd, DOCTOR_DOCUMENT_NUMBER],
    );

    const [localRows] = await db.query(
        `SELECT scheduled_time AS start_time, status FROM appointments
         WHERE scheduled_date = ?
           AND UPPER(status) IN ('CONFIRMED', 'RESCHEDULED', 'PROPOSED', 'QUEUED')`,
        [ymd],
    );

    const booked = new Set();
    for (const row of [...(saludtoolsRows || []), ...(localRows || [])]) {
        const status = String(row.status || "").toUpperCase();
        if (["CANCELLED", "CANCELED", "CANCELADO", "NO_SHOW", "FAILED"].includes(status)) {
            continue;
        }
        const hm = String(row.start_time || "").slice(0, 5);
        if (hm) booked.add(hm);
    }
    return booked;
}

async function buildTimeResponseForDashboard(data) {
    const ymd = ddmmToYmd(data.newDate);
    const booked = await getBookedTimesForYmd(ymd);

    const pageSize = 6;
    const availableSlots = getTimeSlots(0, 1000).filter((hm) => !booked.has(hm));
    const pageStart = (data.page || 0) * pageSize;
    const slots = availableSlots.slice(pageStart, pageStart + pageSize);

    // Se guarda la misma lista filtrada que se muestra, para que al elegir un
    // número (case ASK_TIME) se indexe exactamente sobre lo que la secretaría
    // está viendo — y no sobre la lista completa sin filtrar.
    data.availableSlots = slots;

    let response = "Horas disponibles:\n\n";

    if (!slots.length) {
        response += "No quedan horarios libres en esta página.\n";
    } else {
        slots.forEach((h, i) => {
            response += `${i + 1}️⃣ ${h}\n`;
        });
    }

    if (availableSlots.length > pageStart + pageSize) {
        response += "\n7️⃣ Más horarios";
    }

    response += "\n\n0️⃣ Volver al listado";

    return { response, nextState: "DASHBOARD", data };
}
