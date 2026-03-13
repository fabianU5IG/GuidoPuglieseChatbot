import timeUtils from "../utils/time.js";
import {
    getPendingCases,
    markCancelled,
    markReScheduled,
    registerChatbotInteraction,
    logAppointmentMessage,
} from "../services/chatbot-db.service.js";

import { enqueueSaludtoolsRequest } from "../services/saludtools-rate-limit.service.js";

const { getTimeSlots } = timeUtils;

/**
 * =========================
 *  CONFIG
 * =========================
 */
const SECRETARY_PHONES = ["573153573131"]; // ✅ agrega aquí los números autorizados (solo dígitos)
const SECRETARY_CASES_PAGE_SIZE = 10;

// Duración por defecto para reprogramación en Saludtools (min)
const APPOINTMENT_DURATION_MIN = Number(
    process.env.SALUDTOOLS_APPOINTMENT_DURATION_MIN || 30,
);

// Saludtools config (por ENV)
const SALUDTOOLS_HOST =
    process.env.SALUDTOOLS_HOST || "https://saludtools.qa.carecloud.com.co/";
const SALUDTOOLS_APIKEY = process.env.SALUDTOOLS_APIKEY || "";
const SALUDTOOLS_APISECRET = process.env.SALUDTOOLS_APISECRET || "";

// Doctor / clínica (ajusta en .env)
const DOCTOR_DOCUMENT_TYPE = Number(
    process.env.SALUDTOOLS_DOCTOR_DOCUMENT_TYPE || 1,
);
const DOCTOR_DOCUMENT_NUMBER = String(
    process.env.SALUDTOOLS_DOCTOR_DOCUMENT_NUMBER || "99988877711",
);
const CLINIC_ID = Number(process.env.SALUDTOOLS_CLINIC_ID || 8);

// Defaults (según colección)
const APPOINTMENT_MODALITY =
    process.env.SALUDTOOLS_APPOINTMENT_MODALITY || "CONVENTIONAL";
const APPOINTMENT_STATE = process.env.SALUDTOOLS_APPOINTMENT_STATE || "PENDING";

/**
 * =========================
 *  SALUDTOOLS AUTH + EVENTS
 * =========================
 * Endpoints (Postman collection):
 * - POST /integration/authenticate/apikey/v1/
 * - POST /integration/sync/event/v1/   (APPOINTMENT: UPDATE / DELETE / READ)
 */
let cachedToken = null;
let cachedTokenExp = 0;

async function authenticateSaludtools() {
    if (!SALUDTOOLS_APIKEY || !SALUDTOOLS_APISECRET) return null;

    const now = Date.now();
    if (cachedToken && now < cachedTokenExp - 30_000) return cachedToken;

    const url = new URL(
        "integration/authenticate/apikey/v1/",
        SALUDTOOLS_HOST,
    ).toString();

    const res = await enqueueSaludtoolsRequest(() =>
        fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                key: SALUDTOOLS_APIKEY,
                secret: SALUDTOOLS_APISECRET,
            }),
        }),
    );

    if (!res.ok) {
        const txt = await res.text().catch(() => "");
        throw new Error(`Saludtools auth failed (${res.status}): ${txt}`);
    }

    const json = await res.json();
    const token = json?.access_token || json?.token || null;
    if (!token) throw new Error("Saludtools auth: token not found in response");

    const expiresInSec = Number(json?.expires_in || 3600);
    cachedToken = token;
    cachedTokenExp = Date.now() + expiresInSec * 1000;

    return cachedToken;
}

async function saludtoolsSyncEvent(payload) {
    const token = await authenticateSaludtools();
    if (!token)
        return {
            ok: false,
            skipped: true,
            reason: "Missing SALUDTOOLS credentials",
        };

    const url = new URL(
        "integration/sync/event/v1/",
        SALUDTOOLS_HOST,
    ).toString();

    const res = await enqueueSaludtoolsRequest(() =>
        fetch(url, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${token}`,
            },
            body: JSON.stringify(payload),
        }),
    );

    const text = await res.text().catch(() => "");
    let json = null;
    try {
        json = text ? JSON.parse(text) : null;
    } catch {
        // ignore
    }

    if (!res.ok) {
        return {
            ok: false,
            status: res.status,
            raw: text,
            error: json || text,
            payload,
        };
    }

    return { ok: true, status: res.status, data: json ?? text, payload };
}

// ====== SALUDTOOLS: APPOINTMENT READ (según colección Postman) ======
async function saludtoolsReadAppointment(id) {
    if (!id) return { ok: false, error: "Missing appointment id" };

    const st = await saludtoolsSyncEvent({
        eventType: "APPOINTMENT",
        actionType: "READ",
        body: { id: String(id) },
    });

    return st;
}

function extractAppointmentDocInfo(stRead) {
    // Esta función intenta sacar patientDocumentType/Number desde la respuesta.
    // El API puede variar; por eso lo hacemos defensivo.
    const data = stRead?.data;

    // Intentos comunes
    const root = data?.body || data?.data || data;

    const patientDocumentType =
        root?.patientDocumentType ??
        root?.patient?.documentType ??
        root?.patient?.document_type ??
        null;

    const patientDocumentNumber =
        root?.patientDocumentNumber ??
        root?.patient?.documentNumber ??
        root?.patient?.document_number ??
        null;

    return {
        patientDocumentType:
            patientDocumentType !== null && patientDocumentType !== undefined
                ? Number(patientDocumentType)
                : null,
        patientDocumentNumber:
            patientDocumentNumber !== null &&
            patientDocumentNumber !== undefined
                ? String(patientDocumentNumber)
                : null,
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
    const year = new Date().getFullYear();
    const d = new Date(year, month - 1, day);
    const yyyy = String(d.getFullYear()).padStart(4, "0");
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    const dd = String(d.getDate()).padStart(2, "0");
    return `${yyyy}-${mm}-${dd}`;
}

function isValidDateDDMM(value) {
    if (!/^\d{2}\/\d{2}$/.test(value)) return false;

    const [day, month] = value.split("/").map(Number);
    const year = new Date().getFullYear();

    const date = new Date(year, month - 1, day);
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    return !isNaN(date) && date >= today;
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

function formatCaseLine(c, absoluteIndex) {
    const when =
        c.date || c.time
            ? `🗓️ ${c.date || "Sin fecha"} ${c.time || ""}`.trim()
            : "🗓️ Sin fecha";

    return (
        `${absoluteIndex + 1}️⃣ ${buildPatientDisplay(c)}\n` +
        `${when}\n` +
        `Estado: ${c.status || "N/A"}\n\n`
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

    response += `Página ${paginated.page + 1} de ${Math.max(1, paginated.totalPages)}\n`;

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

async function returnToInbox(extra = "", page = 0) {
    let cases = [];
    try {
        cases = await getPendingCases();
    } catch (err) {
        console.error("❌ Error getPendingCases:", err);
        cases = [];
    }

    if (!Array.isArray(cases)) cases = [];

    return buildPendingCasesResponse(cases, page, extra);
}

/**
 * =========================
 *  DASHBOARD STATE
 * =========================
 */

// ====== DASHBOARD: cancelar cita (DB + Saludtools DELETE) ======
async function cancelSelectedCase({ from, data }) {
    const apptId = data?.selectedCase?.appointment_id;
    const saludId = data?.selectedCase?.saludtools_appointment_id;

    // 1) DB
    try {
        if (apptId) await markCancelled(apptId);

        await registerChatbotInteraction({
            phone: from,
            appointmentId: apptId,
            appointmentData: { newStatus: "CANCELLED" },
        });

        if (apptId) {
            await logAppointmentMessage(
                apptId,
                "Secretaría: marcó CANCELLED desde dashboard",
            );
        }
    } catch (err) {
        console.error("❌ Error cancelando en DB:", err);
    }

    // 2) Saludtools
    let saludtoolsMsg = "Saludtools: omitido";
    if (!data?.skipSaludtools && saludId) {
        saludtoolsMsg = "Saludtools: procesando...";
        try {
            const st = await saludtoolsSyncEvent({
                eventType: "APPOINTMENT",
                actionType: "DELETE",
                body: { id: String(saludId) },
            });

            if (st.skipped) {
                saludtoolsMsg = "Saludtools: omitido (faltan credenciales)";
            } else if (st.ok) {
                saludtoolsMsg = `Saludtools: cita eliminada ✅ (HTTP ${st.status})`;
            } else {
                saludtoolsMsg = `Saludtools: error eliminando ⚠️ (HTTP ${st.status})`;
                if (apptId) {
                    await logAppointmentMessage(
                        apptId,
                        `Saludtools DELETE falló: ${String(st.raw || st.error || "").slice(0, 800)}`,
                    );
                }
            }
        } catch (err) {
            saludtoolsMsg = "Saludtools: error eliminando ⚠️";
            if (apptId) {
                await logAppointmentMessage(
                    apptId,
                    `Error Saludtools DELETE: ${String(err?.message || err).slice(0, 800)}`,
                );
            }
        }
    } else if (!saludId) {
        saludtoolsMsg = "Saludtools: omitido (sin ID)";
    } else if (data?.skipSaludtools) {
        saludtoolsMsg = "Saludtools: omitido (decisión de secretaría)";
    }

    return {
        response:
            "❌ Cita marcada como *CANCELADA*\n\n" +
            `${saludtoolsMsg}\n\n` +
            "1️⃣ Terminar\n" +
            "2️⃣ Volver al dashboard",
        nextState: "DASHBOARD",
        data: { step: "AFTER_ACTION" },
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

    if (!data.step) data.step = "INBOX";

    switch (data.step) {
        /**
         * =========================
         * INBOX
         * =========================
         */
        case "INBOX": {
            let cases = [];
            try {
                cases = await getPendingCases();
            } catch (err) {
                console.error("❌ Error getPendingCases:", err);
                cases = [];
            }

            if (!Array.isArray(cases)) cases = [];

            return buildPendingCasesResponse(cases, 0);
        }

        /**
         * =========================
         * SELECT CASE
         * =========================
         */
        case "SELECT_CASE": {
            if (msg === "0") {
                return {
                    response: "👋 Saliendo del dashboard",
                    nextState: "MENU",
                    data: {},
                };
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

            const details =
                `🔔 Caso seleccionado\n\n` +
                `Paciente: ${buildPatientDisplay(selectedCase)}\n` +
                `Documento: ${extractPatientDocument(selectedCase) || "N/A"}\n` +
                `Cita: ${selectedCase.date || "Sin fecha"} ${selectedCase.time || ""}\n` +
                `Estado: ${selectedCase.status || "N/A"}\n` +
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
                },
            };
        }

        /**
         * =========================
         * CASE ACTIONS
         * =========================
         */
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

        /**
         * =========================
         * RESCHEDULE FLOW
         * =========================
         */

        /**
         * =========================
         * ASK SALUDTOOLS ID (si falta)
         * =========================
         */
        case "ASK_SALUD_ID": {
            const raw = String(msg || "").trim();

            if (raw === "0") {
                // Continuar sin Saludtools
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

            // Guardar ID para la acción
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

        /**
         * =========================
         * DO CANCEL
         * =========================
         */
        case "DO_CANCEL": {
            return await cancelSelectedCase({ from, data });
        }

        case "ASK_DATE": {
            if (msg === "0") {
                return returnToInbox(
                    "↩️ Volviendo al listado",
                    Number(data.page || 0),
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

            data.newDate = msg;
            data.page = 0;
            data.step = "ASK_TIME";
            return buildTimeResponseForDashboard(data);
        }

        case "ASK_TIME": {
            if (msg === "0") {
                return returnToInbox(
                    "↩️ Volviendo al listado",
                    Number(data.page || 0),
                );
            }

            if (msg === "7") {
                data.page++;
                return buildTimeResponseForDashboard(data);
            }

            const index = parseInt(msg, 10) - 1;
            const slots = getTimeSlots(data.page);
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
            if (msg === "0")
                return returnToInbox(
                    "↩️ Acción cancelada. Volviendo al listado.",
                    Number(data.page || 0),
                );

            if (msg !== "1") {
                return {
                    response: "Responde 1️⃣ para confirmar o 0️⃣ para cancelar.",
                    nextState: "DASHBOARD",
                    data,
                };
            }

            const apptId = data?.selectedCase?.appointment_id;
            const saludId = data?.selectedCase?.saludtools_appointment_id;

            // 1) DB: marcar RESCHEDULED
            try {
                if (apptId) {
                    await markReScheduled(apptId, {
                        newDate: data.newDate,
                        newTime: data.newTime,
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

            // 2) Saludtools: UPDATE si hay ID
            let saludtoolsMsg =
                "Saludtools: omitido (sin credenciales o sin ID)";

            try {
                if (saludId) {
                    // Si no tenemos documento del paciente en DB, intentamos leerlo desde Saludtools (APPOINTMENT READ)
                    let patientDocType =
                        data?.selectedCase?.patient_document_type || null;
                    let patientDocNumber =
                        data?.selectedCase?.patient_document_number || null;

                    if (!patientDocType || !patientDocNumber) {
                        const stRead = await saludtoolsReadAppointment(saludId);
                        if (stRead.ok) {
                            const info = extractAppointmentDocInfo(stRead);
                            if (!patientDocType && info.patientDocumentType)
                                patientDocType = info.patientDocumentType;
                            if (!patientDocNumber && info.patientDocumentNumber)
                                patientDocNumber = info.patientDocumentNumber;
                        }
                    }

                    const ymd = ddmmToYmd(data.newDate);
                    const end = addMinutesToYmdHm(
                        ymd,
                        data.newTime,
                        APPOINTMENT_DURATION_MIN,
                    );

                    const st = await saludtoolsSyncEvent({
                        eventType: "APPOINTMENT",
                        actionType: "UPDATE",
                        body: {
                            id: String(saludId),
                            startAppointment: `${ymd} ${data.newTime}`,
                            endAppointment: `${end.ymd} ${end.hm}`,
                            // Campos exigidos por el ejemplo de la colección
                            patientDocumentType: Number(
                                patientDocType ||
                                    process.env
                                        .SALUDTOOLS_PATIENT_DOCUMENT_TYPE ||
                                    1,
                            ),
                            patientDocumentNumber: String(
                                patientDocNumber ||
                                    (data?.selectedCase?.phone || "").replace(
                                        /\D/g,
                                        "",
                                    ) ||
                                    "0",
                            ),
                            doctorDocumentType: DOCTOR_DOCUMENT_TYPE,
                            doctorDocumentNumber: DOCTOR_DOCUMENT_NUMBER,
                            modality: APPOINTMENT_MODALITY,
                            stateAppointment: APPOINTMENT_STATE,
                            notificationState: "ATTEND",
                            appointmentType:
                                data?.selectedCase?.attention_type ||
                                "Cita (reprogramada por secretaría)",
                            clinic: CLINIC_ID,
                            comment: `Reprogramada por secretaría. Paciente: ${extractPatientName(data?.selectedCase || {})}`,
                        },
                    });

                    if (st.skipped) {
                        saludtoolsMsg =
                            "Saludtools: omitido (faltan credenciales)";
                    } else if (st.ok) {
                        saludtoolsMsg = `Saludtools: cita actualizada ✅ (HTTP ${st.status})`;
                    } else {
                        saludtoolsMsg = `Saludtools: error actualizando ⚠️ (HTTP ${st.status})`;
                        if (apptId) {
                            await logAppointmentMessage(
                                apptId,
                                `Saludtools UPDATE falló: ${String(st.raw || st.error || "").slice(0, 800)}`,
                            );
                        }
                    }
                }
            } catch (err) {
                saludtoolsMsg = "Saludtools: error actualizando ⚠️";
                if (apptId) {
                    await logAppointmentMessage(
                        apptId,
                        `Error Saludtools UPDATE: ${String(err?.message || err).slice(0, 800)}`,
                    );
                }
            }

            return {
                response:
                    "🔄 Cita marcada como *REAGENDADA*\n\n" +
                    `Nueva fecha/hora: ${data.newDate} ${data.newTime}\n\n` +
                    `${saludtoolsMsg}\n\n` +
                    "1️⃣ Terminar\n" +
                    "2️⃣ Volver al dashboard",
                nextState: "DASHBOARD",
                data: { step: "AFTER_ACTION" },
            };
        }

        /**
         * =========================
         * AFTER ACTION
         * =========================
         */
        case "AFTER_ACTION": {
            if (msg === "1") {
                return {
                    response: "✅ Proceso finalizado",
                    nextState: "END",
                    data: {},
                };
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

/**
 * =========================
 *  HELPERS UI
 * =========================
 */
function buildTimeResponseForDashboard(data) {
    const slots = getTimeSlots(data.page);
    let response = "Horas disponibles:\n\n";

    slots.forEach((h, i) => {
        response += `${i + 1}️⃣ ${h}\n`;
    });

    if (getTimeSlots(data.page + 1).length) {
        response += "\n7️⃣ Más horarios";
    }

    response += "\n\n0️⃣ Volver al listado";

    return { response, nextState: "DASHBOARD", data };
}
