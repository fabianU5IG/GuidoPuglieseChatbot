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
import {
    createSaludtoolsJob,
    getRecentFailedSaludtoolsJobs,
    retrySaludtoolsJob,
} from "../services/saludtools-jobs.service.js";
import { searchAppointmentsByPatientInSaludtools } from "../services/saludtools-api.service.js";
import { SALUDTOOLS, SECRETARY_PHONES } from "../constants.js";
import {
    parseDashboardAppointmentsAI,
    summarizeSecretaryCasesAI,
    extractDoctorUnavailabilityAI,
    classifyDashboardIntentAI,
} from "../services/azure.ai.services.js";
import {
    addDoctorUnavailability,
    getScheduleBlocksForYmd,
    removeDoctorUnavailabilityForYmd,
} from "../services/doctor-schedule.service.js";

/**
 * =========================
 *  CONFIG
 * =========================
 */
const SECRETARY_CASES_PAGE_SIZE = 10;

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
    "4️⃣ Cancelar cita\n" +
    "5️⃣ Reagendar cita\n" +
    "6️⃣ Sincronizaciones fallidas\n\n" +
    "💬 También puedes escribir, por ejemplo: \"el jueves el doctor no está disponible\" o \"el jueves no está de 8 a 9\" para bloquear un día u horario, o \"desbloquea el 1/09\" para quitarlo.\n\n" +
    "0️⃣ Salir";

// Antes, "0️⃣ Salir"/"1️⃣ Terminar" del panel reutilizaban por error la
// misma función de salida que usan los pacientes al terminar en el menú
// (MENU), que manda la plantilla de bienvenida del consultorio — la
// secretaria terminaba viendo literalmente el mensaje de bienvenida de un
// paciente nuevo. El panel nunca "sale" de verdad (chatbot.js siempre
// devuelve a un número de secretaría a DASHBOARD), así que esto solo
// despide y reinicia el paso interno al menú del panel.
function exitDashboard() {
    return {
        response: "👋 Listo, quedo atenta a lo que necesites.",
        nextState: "DASHBOARD",
        data: { step: "MENU" },
    };
}

function buildQuickAppointmentPrompt() {
    return (
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
        "Cuando termines, escribe *fin* o *0*."
    );
}

// Filtro barato para no gastar una llamada real a Azure OpenAI en el caso
// normal (número de menú, índice de lista, fecha DD/MM, documento con
// prefijo): la IA de intención del panel solo debe llamarse cuando el texto
// realmente no calzó con nada esperado en el paso actual.
function looksLikeStructuredDashboardInput(raw) {
    const trimmed = String(raw || "").trim();
    if (!trimmed) return true;
    if (/^\d{1,4}$/.test(trimmed)) return true;
    if (/^\d{1,2}\/\d{1,2}$/.test(trimmed)) return true;
    if (/^(cc|ce|ti|rc|pa)\s*\d+$/i.test(trimmed)) return true;
    return false;
}

const AI_DASHBOARD_FALLBACK_MIN_CONFIDENCE = Number(
    process.env.AI_NAV_FALLBACK_MIN_CONFIDENCE || 0.7,
);

/**
 * Único punto de entrada de IA para "no reconocí este mensaje" dentro del
 * panel de secretaría — igual en espíritu a resolveFlowFallback() del lado
 * de pacientes, pero con las acciones propias del dashboard. Se llama desde
 * cada paso, justo antes de su propio mensaje de "opción inválida", y NUNCA
 * lanza: si no hay nada confiable que hacer, devuelve null y el llamador
 * simplemente sigue con su comportamiento de siempre.
 */
async function applyDashboardAIFallback(msg, currentStep) {
    if (looksLikeStructuredDashboardInput(msg)) return null;

    try {
        const result = await classifyDashboardIntentAI({
            message: msg,
            currentStep,
        });

        const decision =
            !result || result.confidence < AI_DASHBOARD_FALLBACK_MIN_CONFIDENCE
                ? "LOW_CONFIDENCE"
                : result.intent;

        console.log("🧭 IA fallback dashboard:", {
            currentStep,
            message: msg,
            intent: result?.intent || null,
            confidence: result?.confidence ?? null,
            decision,
        });

        if (decision === "LOW_CONFIDENCE" || decision === "UNKNOWN") return null;

        switch (decision) {
            case "GO_MAIN_MENU":
                return {
                    response: DASHBOARD_MENU_TEXT,
                    nextState: "DASHBOARD",
                    data: { step: "MENU" },
                };

            case "GO_PENDING_CASES": {
                const cases = await getAllPendingCases();
                return buildPendingCasesResponse(cases, 0);
            }

            case "GO_AI_SUMMARY": {
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

            case "GO_CANCEL":
                return {
                    response:
                        "❌ *Cancelar cita*\n\n" +
                        "¿A nombre de quién está la cita? Escribe el nombre del paciente o su número de documento.\n\n" +
                        "0️⃣ Cancelar",
                    nextState: "DASHBOARD",
                    data: { step: "CANCEL_ASK_PATIENT" },
                };

            case "GO_RESCHEDULE":
                return {
                    response:
                        "🔄 *Reagendar cita*\n\n" +
                        "¿A nombre de quién está la cita? Escribe el nombre del paciente o su número de documento.\n\n" +
                        "0️⃣ Cancelar",
                    nextState: "DASHBOARD",
                    data: { step: "RESCHEDULE_ASK_PATIENT" },
                };

            case "GO_QUICK_APPOINTMENT":
                return {
                    response: buildQuickAppointmentPrompt(),
                    nextState: "DASHBOARD",
                    data: { step: "QUICK_BULK_MESSAGE" },
                };

            case "GO_FAILED_JOBS":
                return await buildFailedJobsResponse();

            case "EXIT":
                return exitDashboard();

            default:
                return null;
        }
    } catch (error) {
        console.error("❌ applyDashboardAIFallback error inesperado:", error);
        return null;
    }
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

// La cita rápida del dashboard nunca colecta los datos completos de registro
// del paciente (nombre por partes, nacimiento, género, EPS, habeas data) que
// sí pide agendar.state.js, así que el paciente en Saludtools se asume
// existente (patientExistsLocal: true) — la secretaria la usa para pacientes
// que ya conoce, encontrados por nombre o dando directamente su documento. Si
// el documento no existe todavía en Saludtools, la creación de la cita
// fallará allá y la secretaria lo verá en el aviso de error del job.
async function enqueueQuickAppointmentSaludtoolsJob({
    phone,
    appointmentId,
    dateLabel,
    timeLabel,
    documentType,
    documentNumber,
    patientName,
}) {
    const ymd = ddmmToYmd(dateLabel);
    const end = addMinutesToYmdHm(ymd, timeLabel, APPOINTMENT_DURATION_MIN);

    await createSaludtoolsJob({
        jobType: "APPOINTMENT_CREATE",
        phone,
        appointmentId,
        dedupeKey: `dashboard-appointment-create:${documentType}:${documentNumber}:${ymd}:${timeLabel}`,
        payload: {
            fullName: patientName,
            dateLabel,
            timeLabel,
            patientExistsLocal: true,
            appointmentBody: {
                startAppointment: `${ymd} ${timeLabel}`,
                endAppointment: `${end.ymd} ${end.hm}`,
                patientDocumentType: Number(documentType),
                patientDocumentNumber: String(documentNumber),
                doctorDocumentType: DOCTOR_DOCUMENT_TYPE,
                doctorDocumentNumber: DOCTOR_DOCUMENT_NUMBER,
                modality: APPOINTMENT_MODALITY,
                stateAppointment: APPOINTMENT_STATE,
                appointmentType: "Cita rápida (creada por secretaría)",
                clinic: CLINIC_ID,
                comment: `Cita rápida creada por secretaría. Paciente: ${patientName || "N/A"}.`,
            },
            source: "SECRETARY_DASHBOARD",
        },
        priority: 100,
    });
}

async function createQuickAppointmentForCandidate({
    pendingAppointment,
    candidate,
    from,
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

        let syncMsg = "";
        if (result.created) {
            try {
                await enqueueQuickAppointmentSaludtoolsJob({
                    phone: from,
                    appointmentId: result.appointmentId,
                    dateLabel: pendingAppointment.dateLabel,
                    timeLabel: pendingAppointment.timeLabel,
                    documentType: candidate.document_type,
                    documentNumber: candidate.document_number,
                    patientName: candidate.full_name,
                });
                syncMsg =
                    "\n\nYa quedó todo registrado y en un momento se actualiza también en Saludtools. ✅";
            } catch (error) {
                console.error(
                    "❌ No fue posible encolar la cita rápida para Saludtools:",
                    error,
                );
                syncMsg =
                    "\n\nQuedó creada por acá, pero tuvimos un problema avisándole a Saludtools. Tranquila, lo vamos a reintentar solo.";
            }
        }

        return {
            response:
                `✅ ${result.created ? "Cita creada" : "Ya existía esa cita"} para ` +
                `${candidate.full_name} (${docTypeLabel(candidate.document_type)} ${candidate.document_number}) ` +
                `el ${pendingAppointment.dateLabel} a las ${pendingAppointment.timeLabel} ` +
                `(${String(pendingAppointment.modality).toLowerCase()}).` +
                syncMsg +
                "\n\n" +
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

async function resolveQuickAppointmentPatientName({ pendingAppointment, data, from }) {
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
            from,
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

const FAILED_JOB_TYPE_LABELS = {
    APPOINTMENT_CREATE: "Crear cita",
    APPOINTMENT_UPDATE: "Reagendar cita",
    APPOINTMENT_DELETE: "Cancelar cita",
    SUPPORT_APPOINTMENT_SEARCH: "Buscar citas (soporte)",
};

// Jobs que agotaron todos sus reintentos automáticos (ver
// computeRetryDelaySeconds en el worker): antes quedaban invisibles salvo
// consultando la tabla saludtools_jobs a mano, aunque la cita nunca hubiera
// llegado a Saludtools.
function describeFailedSaludtoolsJob(job) {
    const label = FAILED_JOB_TYPE_LABELS[job.job_type] || job.job_type;
    const payload = job.payload || {};
    const appt = payload.appointmentBody || {};
    const docNumber = appt.patientDocumentNumber || payload.documento || "N/A";
    const when =
        appt.startAppointment ||
        (payload.dateLabel && payload.timeLabel
            ? `${payload.dateLabel} ${payload.timeLabel}`
            : null);
    const errorSnippet = String(job.last_error || "").slice(0, 140);

    return (
        `${label} — Doc ${docNumber}${when ? ` — ${when}` : ""}\n` +
        `Intentos: ${job.attempts} · ${new Date(job.updated_at).toLocaleString("es-CO")}\n` +
        `Error: ${errorSnippet}`
    );
}

async function buildFailedJobsResponse(extra = "") {
    const jobs = await getRecentFailedSaludtoolsJobs(15);

    if (!jobs.length) {
        return {
            response:
                `${extra}😊 No hay sincronizaciones fallidas con Saludtools pendientes de revisar.\n\n` +
                DASHBOARD_MENU_TEXT,
            nextState: "DASHBOARD",
            data: { step: "MENU" },
        };
    }

    const lines = jobs
        .map((job, idx) => `${idx + 1}️⃣ ${describeFailedSaludtoolsJob(job)}`)
        .join("\n\n");

    return {
        response:
            `${extra}⚠️ Sincronizaciones fallidas con Saludtools (${jobs.length}):\n\n` +
            `${lines}\n\n` +
            "Escribe el número para reintentarla, o 0️⃣ para volver al menú.",
        nextState: "DASHBOARD",
        data: { step: "FAILED_JOBS_LIST", failedJobs: jobs },
    };
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

    let workerMsg = "Ya quedó todo registrado. ✅";
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

            workerMsg = "Ya quedó todo registrado y en un momento se actualiza también en Saludtools. ✅";

            if (apptId) {
                await logAppointmentMessage(
                    apptId,
                    "Solicitud de cancelación encolada para worker desde dashboard",
                );
            }
        } else if (!saludId) {
            workerMsg = "Ya quedó cancelada. ✅";
        } else if (data?.skipSaludtools) {
            workerMsg = "Ya quedó cancelada. No se sincronizó con Saludtools, tal como lo pediste.";
        }
    } catch (err) {
        workerMsg =
            "Ya quedó cancelada por acá, pero tuvimos un problema avisándole a Saludtools. Tranquila, lo vamos a reintentar solo.";
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
            "✅ Cita cancelada.\n\n" +
            `${workerMsg}\n\n` +
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

// Mismo patrón de búsqueda que "Cancelar cita" (nombre/documento contra
// Saludtools real), pero en vez de terminar cancelando, entrega la cita
// elegida al flujo de reagendamiento (ASK_DATE/ASK_TIME/CONFIRM_RESCHEDULE)
// que ya existía para reagendar desde "Ver casos pendientes".
function buildRescheduleAppointmentPrompt(appointments) {
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
        "Responde con el número de la que quieres reagendar.\n\n" +
        "0️⃣ Cancelar"
    );
}

async function startRescheduleFlowForDocument({
    documentType,
    documentNumber,
    patientName = null,
    data,
}) {
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
        response: buildRescheduleAppointmentPrompt(appointments),
        nextState: "DASHBOARD",
        data: {
            ...data,
            step: "RESCHEDULE_SELECT_APPOINTMENT",
            rescheduleDocumentType: documentType,
            rescheduleDocumentNumber: documentNumber,
            reschedulePatientName: patientName,
            rescheduleAppointments: appointments,
        },
    };
}

async function startRescheduleFlowForPatientName({ patientName, data }) {
    let candidates = [];
    try {
        candidates = await findSaludtoolsPatientsByName(patientName);
    } catch (error) {
        console.error("❌ Error buscando paciente por nombre:", error);
    }

    if (candidates.length === 1) {
        return startRescheduleFlowForDocument({
            documentType: Number(candidates[0].document_type),
            documentNumber: String(candidates[0].document_number),
            patientName: candidates[0].full_name,
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
                step: "RESCHEDULE_SELECT_PATIENT",
                reschedulePatientCandidates: candidates,
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
            step: "RESCHEDULE_ASK_PATIENT",
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
                return exitDashboard();
            }

            if (msg === "1") {
                data.step = "QUICK_BULK_MESSAGE";
                return {
                    response: buildQuickAppointmentPrompt(),
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

            if (msg === "5") {
                data.step = "RESCHEDULE_ASK_PATIENT";
                return {
                    response:
                        "🔄 *Reagendar cita*\n\n" +
                        "¿A nombre de quién está la cita? Escribe el nombre del paciente o su número de documento.\n\n" +
                        "0️⃣ Cancelar",
                    nextState: "DASHBOARD",
                    data,
                };
            }

            if (msg === "6") {
                return await buildFailedJobsResponse();
            }

            // Antes, bloquear un día del doctor requería que alguien tocara
            // la base de datos a mano. Ahora la secretaria puede avisarlo en
            // lenguaje natural (ej: "el jueves el doctor no está
            // disponible") directamente desde el menú, sin pasos ni botones.
            const unavailability = await extractDoctorUnavailabilityAI({
                message: msg,
                todayYmd: new Date().toISOString().slice(0, 10),
            });

            if (unavailability?.isUnavailability && unavailability.confidence >= 0.7) {
                if (!unavailability.startDate) {
                    return {
                        response:
                            (unavailability.action === "UNBLOCK"
                                ? "Entendí que quieres quitar un bloqueo, pero no logré identificar la fecha exacta.\n\n"
                                : "Entendí que el doctor no va a estar disponible, pero no logré identificar la fecha exacta.\n\n") +
                            "¿Me confirmas el día? Por ejemplo: \"el jueves 4 de septiembre\" o \"del 10 al 12 de septiembre\".",
                        nextState: "DASHBOARD",
                        data,
                    };
                }

                const formatBlockDate = (ymd) => {
                    const [y, m, d] = String(ymd).split("-");
                    return `${d}/${m}/${y}`;
                };
                const rangeLabel =
                    unavailability.startDate === unavailability.endDate
                        ? formatBlockDate(unavailability.startDate)
                        : `${formatBlockDate(unavailability.startDate)} al ${formatBlockDate(unavailability.endDate)}`;

                if (unavailability.action === "UNBLOCK") {
                    try {
                        const removed = await removeDoctorUnavailabilityForYmd(
                            unavailability.startDate,
                        );

                        return {
                            response:
                                (removed
                                    ? `✅ Listo, quité el bloqueo del ${rangeLabel}.\n\nEl bot ya vuelve a ofrecer horarios normales ese día.`
                                    : `😊 No tenía ningún bloqueo registrado para el ${rangeLabel}.`) +
                                "\n\n" +
                                DASHBOARD_MENU_TEXT,
                            nextState: "DASHBOARD",
                            data: { step: "MENU" },
                        };
                    } catch (error) {
                        console.error(
                            "❌ No fue posible quitar el bloqueo del doctor:",
                            error,
                        );
                        return {
                            response:
                                "😊 Tuve un problema quitando el bloqueo. Intenta de nuevo en un momento.\n\n" +
                                DASHBOARD_MENU_TEXT,
                            nextState: "DASHBOARD",
                            data: { step: "MENU" },
                        };
                    }
                }

                try {
                    await addDoctorUnavailability({
                        startDate: unavailability.startDate,
                        endDate: unavailability.endDate,
                        startTime: unavailability.startTime,
                        endTime: unavailability.endTime,
                        reason: unavailability.reason,
                        createdBy: context.from,
                    });

                    const hourLabel =
                        unavailability.startTime && unavailability.endTime
                            ? ` de ${unavailability.startTime} a ${unavailability.endTime}`
                            : " (todo el día)";

                    return {
                        response:
                            `✅ Listo, bloqueé al doctor para el ${rangeLabel}${hourLabel}` +
                            `${unavailability.reason ? ` (${unavailability.reason})` : ""}.\n\n` +
                            "El bot ya no va a ofrecer esos horarios en la agenda.\n\n" +
                            DASHBOARD_MENU_TEXT,
                        nextState: "DASHBOARD",
                        data: { step: "MENU" },
                    };
                } catch (error) {
                    console.error(
                        "❌ No fue posible registrar el bloqueo del doctor:",
                        error,
                    );
                    return {
                        response:
                            "😊 Tuve un problema guardando el bloqueo. Intenta de nuevo en un momento.\n\n" +
                            DASHBOARD_MENU_TEXT,
                        nextState: "DASHBOARD",
                        data: { step: "MENU" },
                    };
                }
            }

            const aiFallback = await applyDashboardAIFallback(msg, "MENU");
            if (aiFallback) return aiFallback;

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
                    from,
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

                    let syncQueued = false;
                    if (localResult.created) {
                        try {
                            await enqueueQuickAppointmentSaludtoolsJob({
                                phone: from,
                                appointmentId: localResult.appointmentId,
                                dateLabel: item.dateLabel,
                                timeLabel: item.timeLabel,
                                documentType: item.patientDocumentType,
                                documentNumber: item.patientDocumentNumber,
                                patientName: `Paciente ${item.rawDocType.toUpperCase()} ${item.patientDocumentNumber}`,
                            });
                            syncQueued = true;
                        } catch (syncError) {
                            console.error(
                                "❌ No fue posible encolar la cita rápida para Saludtools:",
                                syncError,
                            );
                        }
                    }

                    inserted.push({
                        lineNumber: item.lineNumber,
                        id: localResult.appointmentId,
                        created: localResult.created,
                        syncQueued,
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
            const syncedCount = inserted.filter((item) => item.syncQueued).length;

            let response =
                `✅ Guardadas en la base de datos: ${createdCount}\n` +
                `ℹ️ Ya existentes: ${duplicateCount}\n` +
                `❌ Con error: ${invalid.length + failed.length}\n\n`;

            if (inserted.length) {
                response +=
                    (usedAI ? "🤖 Interpreté el mensaje con IA.\n\n" : "") +
                    "Citas registradas localmente:\n";
                inserted.slice(0, 20).forEach((item) => {
                    const syncNote = !item.created
                        ? ""
                        : item.syncQueued
                          ? " · sincronizando con Saludtools"
                          : " · ⚠️ no se pudo sincronizar con Saludtools";
                    response +=
                        `Línea ${item.lineNumber}: ${item.dateLabel} ${item.timeLabel} ` +
                        `${item.rawDocType.toUpperCase()} ${item.patientDocumentNumber} ` +
                        `(${item.modality})${item.created ? "" : " - ya existía"}${syncNote}\n`;
                });
                response += syncedCount
                    ? "Ya quedó todo registrado y en un momento se actualiza también en Saludtools. ✅\n\n"
                    : "\n";
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
                    from,
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
                    from,
                });
            }

            const quickSelectFallback = await applyDashboardAIFallback(
                msg,
                "QUICK_SELECT_PATIENT",
            );
            if (quickSelectFallback) return quickSelectFallback;

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
                const quickDocFallback = await applyDashboardAIFallback(
                    msg,
                    "QUICK_ASK_DOCUMENT",
                );
                if (quickDocFallback) return quickDocFallback;

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
                from,
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

            const cancelSelectPatientFallback = await applyDashboardAIFallback(
                msg,
                "CANCEL_SELECT_PATIENT",
            );
            if (cancelSelectPatientFallback) return cancelSelectPatientFallback;

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
                const cancelSelectApptFallback = await applyDashboardAIFallback(
                    msg,
                    "CANCEL_SELECT_APPOINTMENT",
                );
                if (cancelSelectApptFallback) return cancelSelectApptFallback;

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

        case "RESCHEDULE_ASK_PATIENT": {
            if (msg === "0" || isExitQuickBulkCommand(msg)) {
                return {
                    response: "✅ Cancelado.\n\n" + DASHBOARD_MENU_TEXT,
                    nextState: "DASHBOARD",
                    data: { step: "MENU" },
                };
            }

            const directDoc = parseQuickDocumentReply(msg);
            if (directDoc.documentNumber) {
                return startRescheduleFlowForDocument({
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

            return startRescheduleFlowForPatientName({ patientName, data });
        }

        case "RESCHEDULE_SELECT_PATIENT": {
            if (msg === "0" || isExitQuickBulkCommand(msg)) {
                return {
                    response: "✅ Cancelado.\n\n" + DASHBOARD_MENU_TEXT,
                    nextState: "DASHBOARD",
                    data: { step: "MENU" },
                };
            }

            const candidates = Array.isArray(data.reschedulePatientCandidates)
                ? data.reschedulePatientCandidates
                : [];
            const selectedIndex = Number(msg);

            if (
                Number.isInteger(selectedIndex) &&
                selectedIndex >= 1 &&
                selectedIndex <= candidates.length
            ) {
                const candidate = candidates[selectedIndex - 1];
                return startRescheduleFlowForDocument({
                    documentType: Number(candidate.document_type),
                    documentNumber: String(candidate.document_number),
                    patientName: candidate.full_name,
                    data,
                });
            }

            const directDoc = parseQuickDocumentReply(msg);
            if (directDoc.documentNumber) {
                return startRescheduleFlowForDocument({
                    documentType: directDoc.documentType,
                    documentNumber: directDoc.documentNumber,
                    data,
                });
            }

            const rescheduleSelectPatientFallback = await applyDashboardAIFallback(
                msg,
                "RESCHEDULE_SELECT_PATIENT",
            );
            if (rescheduleSelectPatientFallback) return rescheduleSelectPatientFallback;

            return {
                response:
                    "😊 No entendí tu respuesta. Responde con el número de la lista, el documento directamente, o 0 para cancelar.",
                nextState: "DASHBOARD",
                data,
            };
        }

        case "RESCHEDULE_SELECT_APPOINTMENT": {
            if (msg === "0" || isExitQuickBulkCommand(msg)) {
                return {
                    response: "✅ Cancelado.\n\n" + DASHBOARD_MENU_TEXT,
                    nextState: "DASHBOARD",
                    data: { step: "MENU" },
                };
            }

            const appointments = Array.isArray(data.rescheduleAppointments)
                ? data.rescheduleAppointments
                : [];
            const index = Number(msg) - 1;

            if (!Number.isInteger(index) || !appointments[index]) {
                const rescheduleSelectApptFallback = await applyDashboardAIFallback(
                    msg,
                    "RESCHEDULE_SELECT_APPOINTMENT",
                );
                if (rescheduleSelectApptFallback) return rescheduleSelectApptFallback;

                return {
                    response:
                        buildRescheduleAppointmentPrompt(appointments) +
                        "\n\n❌ No reconocí esa opción, intenta de nuevo.",
                    nextState: "DASHBOARD",
                    data,
                };
            }

            const chosenAppt = appointments[index];

            return {
                response:
                    `🔄 Vamos a reagendar la cita del ${String(chosenAppt.startAppointment).replace("T", " ")}.\n\n` +
                    "Ingresa la nueva fecha (DD/MM):",
                nextState: "DASHBOARD",
                data: {
                    ...data,
                    step: "ASK_DATE",
                    pendingAction: "RESCHEDULE",
                    skipSaludtools: false,
                    selectedCase: {
                        saludtools_appointment_id: chosenAppt.id,
                        patient_document_type: data.rescheduleDocumentType,
                        patient_document_number: data.rescheduleDocumentNumber,
                        fullName: data.reschedulePatientName || null,
                    },
                },
            };
        }

        case "INBOX": {
            const cases = await getAllPendingCases();
            return buildPendingCasesResponse(cases, 0);
        }

        case "SELECT_CASE": {
            if (msg === "0") {
                return exitDashboard();
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
                const selectCaseFallback = await applyDashboardAIFallback(
                    msg,
                    "SELECT_CASE",
                );
                if (selectCaseFallback) return selectCaseFallback;

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

            const secretaryCaseFallback = await applyDashboardAIFallback(
                msg,
                "SECRETARY_CASE_ACTIONS",
            );
            if (secretaryCaseFallback) return secretaryCaseFallback;

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

            const caseActionsFallback = await applyDashboardAIFallback(
                msg,
                "CASE_ACTIONS",
            );
            if (caseActionsFallback) return caseActionsFallback;

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
                const saludIdFallback = await applyDashboardAIFallback(
                    msg,
                    "ASK_SALUD_ID",
                );
                if (saludIdFallback) return saludIdFallback;

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
                const askDateFallback = await applyDashboardAIFallback(msg, "ASK_DATE");
                if (askDateFallback) return askDateFallback;

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

            // Si el día resultó sin atención (festivo, bloqueado, o
            // simplemente no le toca), el mensaje anterior invita a escribir
            // otra fecha — pero seguíamos esperando solo un número de la
            // lista (vacía) y cualquier fecha nueva caía en "Opción
            // inválida". Ahora si escribe una fecha aquí, se reintenta con
            // esa fecha en vez de quedar atascado.
            if (isValidDateDDMM(msg)) {
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
                return await buildTimeResponseForDashboard(data);
            }

            if (msg === "7") {
                data.page++;
                return await buildTimeResponseForDashboard(data);
            }

            const index = parseInt(msg, 10) - 1;
            const slots = Array.isArray(data.availableSlots) ? data.availableSlots : [];
            const hour = slots[index];

            if (!hour) {
                const askTimeFallback = await applyDashboardAIFallback(msg, "ASK_TIME");
                if (askTimeFallback) return askTimeFallback;

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

            let workerMsg = "Ya quedó todo registrado. ✅";
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
                        "Ya quedó todo registrado y en un momento se actualiza también en Saludtools. ✅";

                    if (apptId) {
                        await logAppointmentMessage(
                            apptId,
                            `Solicitud de reagendamiento encolada para worker: ${ymd} ${data.newTime}`,
                        );
                    }
                } else if (!saludId) {
                    workerMsg = "Ya quedó reagendada. ✅";
                } else if (data?.skipSaludtools) {
                    workerMsg = "Ya quedó reagendada. No se sincronizó con Saludtools, tal como lo pediste.";
                }
            } catch (err) {
                workerMsg =
                    "Ya quedó reagendada por acá, pero tuvimos un problema avisándole a Saludtools. Tranquila, lo vamos a reintentar solo.";
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
                    "✅ Cita reagendada.\n\n" +
                    `Nueva fecha y hora: ${data.newDate} ${data.newTime}\n\n` +
                    `${workerMsg}\n\n` +
                    "1️⃣ Terminar\n" +
                    "2️⃣ Volver al dashboard",
                nextState: "DASHBOARD",
                data: { step: "AFTER_ACTION" },
            };
        }

        case "AFTER_ACTION": {
            if (msg === "1") {
                return exitDashboard();
            }

            // Antes esto saltaba directo al listado de casos pendientes
            // (paso INBOX) aunque el botón decía "Volver al dashboard" — la
            // secretaria terminaba en una pantalla distinta a la que
            // esperaba. Ahora sí muestra el menú principal del panel.
            if (msg === "2") {
                return {
                    response: DASHBOARD_MENU_TEXT,
                    nextState: "DASHBOARD",
                    data: { step: "MENU" },
                };
            }

            const afterActionFallback = await applyDashboardAIFallback(
                msg,
                "AFTER_ACTION",
            );
            if (afterActionFallback) return afterActionFallback;

            return {
                response: "Selecciona 1️⃣ o 2️⃣",
                nextState: "DASHBOARD",
                data,
            };
        }

        case "FAILED_JOBS_LIST": {
            if (msg === "0") {
                return {
                    response: DASHBOARD_MENU_TEXT,
                    nextState: "DASHBOARD",
                    data: { step: "MENU" },
                };
            }

            const jobs = Array.isArray(data.failedJobs) ? data.failedJobs : [];
            const index = Number(msg) - 1;
            const chosen = jobs[index];

            if (!Number.isInteger(index) || !chosen) {
                const failedJobsFallback = await applyDashboardAIFallback(
                    msg,
                    "FAILED_JOBS_LIST",
                );
                if (failedJobsFallback) return failedJobsFallback;

                return buildFailedJobsResponse("❌ No reconocí esa opción.\n\n");
            }

            const retried = await retrySaludtoolsJob(chosen.id);

            return buildFailedJobsResponse(
                retried
                    ? "🔄 Listo, la puse de nuevo en la fila. En un momento el sistema la vuelve a intentar.\n\n"
                    : "😊 Esa sincronización ya no estaba pendiente de reintento (puede que alguien ya la haya resuelto).\n\n",
            );
        }

        default:
            return {
                response: DASHBOARD_MENU_TEXT,
                nextState: "DASHBOARD",
                data: { step: "MENU" },
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

    // Cuando Saludtools ya tiene un registro para una hora exacta, su estado
    // manda sobre la tabla local vieja `appointments` para esa misma hora
    // (esa tabla no se actualiza cuando una cita se cancela directamente en
    // Saludtools y puede quedar diciendo CONFIRMED para siempre). Mismo fix
    // ya aplicado en agendar.state.js para que agendar y reagendar vean la
    // misma disponibilidad.
    const saludtoolsTimesKnown = new Set(
        (saludtoolsRows || []).map((row) => String(row.start_time || "").slice(0, 5)),
    );
    const filteredLocalRows = (localRows || []).filter(
        (row) => !saludtoolsTimesKnown.has(String(row.start_time || "").slice(0, 5)),
    );

    const booked = new Set();
    for (const row of [...(saludtoolsRows || []), ...filteredLocalRows]) {
        const status = String(row.status || "").toUpperCase();
        if (["CANCELLED", "CANCELED", "CANCELADO", "NO_SHOW", "FAILED"].includes(status)) {
            continue;
        }
        const hm = String(row.start_time || "").slice(0, 5);
        if (hm) booked.add(hm);
    }
    return booked;
}

function pad2(n) {
    return String(n).padStart(2, "0");
}

function buildSlots(startHm, endHm, slotMin) {
    const [sh, sm] = startHm.split(":").map(Number);
    const [eh, em] = endHm.split(":").map(Number);
    const startTotal = sh * 60 + sm;
    const endTotal = eh * 60 + em;
    const lastStart = endTotal - slotMin;
    const slots = [];

    for (let t = startTotal; t <= lastStart; t += slotMin) {
        slots.push(`${pad2(Math.floor(t / 60))}:${pad2(t % 60)}`);
    }
    return slots;
}

async function buildTimeResponseForDashboard(data) {
    const ymd = ddmmToYmd(data.newDate);

    // Antes esto generaba horas genéricas (getTimeSlots) sin conocer el
    // horario real del doctor (con almuerzo, viernes solo mañana) ni los
    // bloqueos manuales de la secretaria: la secretaría podía terminar
    // reagendando a una hora que el propio bot le dice al paciente que no
    // existe. Ahora usa el mismo horario centralizado que agendar/soporteCita.
    const blocks = await getScheduleBlocksForYmd(ymd);
    if (!blocks.length) {
        data.availableSlots = [];
        return {
            response:
                `😊 El Dr. no tiene atención el día ${data.newDate}.\n\n` +
                "Ingresa otra fecha (DD/MM), o 0️⃣ para volver al listado.",
            nextState: "DASHBOARD",
            data,
        };
    }

    const booked = await getBookedTimesForYmd(ymd);

    const pageSize = 6;
    const availableSlots = blocks
        .flatMap((block) => buildSlots(block.start, block.end, APPOINTMENT_DURATION_MIN))
        .filter((hm) => !booked.has(hm));
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
