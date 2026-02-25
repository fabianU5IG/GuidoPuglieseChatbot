import timeUtils from "../utils/time.js";
import {
    getPendingCases,
    markCancelled,
    markReScheduled,
    registerChatbotInteraction,
    logAppointmentMessage,
} from "../services/chatbot-db.service.js";

const { getTimeSlots } = timeUtils;

/**
 * =========================
 *  CONFIG
 * =========================
 */
const SECRETARY_PHONES = ["573153573131"]; // ✅ agrega aquí los números autorizados (solo dígitos)

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

    const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            key: SALUDTOOLS_APIKEY,
            secret: SALUDTOOLS_APISECRET,
        }),
    });

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

    const res = await fetch(url, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(payload),
    });

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

function formatCaseLine(c, i) {
    let formattedDate = "Sin fecha";
    if (c.last_update) {
        const d = new Date(c.last_update);
        if (!isNaN(d)) formattedDate = d.toLocaleString();
    }

    const when = c.date && c.time ? `🗓️ ${c.date} ${c.time}` : "";
    const type = c.attention_type ? `• ${c.attention_type}` : "";

    return (
        `${i + 1}️⃣ ${c.full_name || "Paciente"} ${type}\n` +
        `📞 ${c.phone || "Sin teléfono"}\n` +
        (when ? `${when}\n` : "") +
        `🕒 ${formattedDate}\n\n`
    );
}

function dashboardHeader() {
    return "📋 Dashboard Secretaría\n\n";
}

function returnToInbox(extra = "") {
    return {
        response: extra ? `${extra}\n` : null,
        nextState: "DASHBOARD",
        data: { step: "INBOX" },
    };
}

/**
 * =========================
 *  DASHBOARD STATE
 * =========================
 */
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

            if (cases.length === 0) {
                return {
                    response:
                        dashboardHeader() +
                        "No hay casos pendientes.\n\n0️⃣ Salir",
                    nextState: "DASHBOARD",
                    data: { step: "INBOX" },
                };
            }

            let response = "📋 Casos pendientes:\n\n";
            cases.slice(0, 10).forEach((c, i) => {
                response += formatCaseLine(c, i);
            });

            if (cases.length > 10)
                response += "\n... Mostrando primeros 10 casos\n";

            response += "\nSelecciona un caso o escribe 0️⃣ para salir";

            return {
                response,
                nextState: "DASHBOARD",
                data: { step: "SELECT_CASE", cases },
            };
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

            const index = parseInt(msg, 10) - 1;
            if (!Number.isInteger(index) || !data.cases?.[index]) {
                return {
                    response: "❌ Opción inválida",
                    nextState: "DASHBOARD",
                    data: { step: "INBOX" },
                };
            }

            const selectedCase = data.cases[index];

            const details =
                `🔔 Caso seleccionado\n\n` +
                `Paciente: ${selectedCase.full_name || "N/A"}\n` +
                `Tel: ${selectedCase.phone || "N/A"}\n` +
                (selectedCase.date && selectedCase.time
                    ? `Cita: ${selectedCase.date} ${selectedCase.time}\n`
                    : "") +
                (selectedCase.attention_type
                    ? `Tipo: ${selectedCase.attention_type}\n`
                    : "") +
                (selectedCase.saludtools_appointment_id
                    ? `Saludtools ID: ${selectedCase.saludtools_appointment_id}\n`
                    : "Saludtools ID: (no disponible)\n") +
                "\n" +
                "1️⃣ Reagendar\n" +
                "2️⃣ Cancelar\n" +
                "0️⃣ Volver";

            return {
                response: details,
                nextState: "DASHBOARD",
                data: { step: "CASE_ACTIONS", selectedCase },
            };
        }

        /**
         * =========================
         * CASE ACTIONS
         * =========================
         */
        case "CASE_ACTIONS": {
            if (msg === "0") return returnToInbox("↩️ Volviendo al listado");

            if (msg === "1") {
                return {
                    response:
                        "🔄 Reagendar cita\n\nIngresa la nueva fecha (DD/MM):",
                    nextState: "DASHBOARD",
                    data: { ...data, step: "ASK_DATE" },
                };
            }

            if (msg === "2") {
                // CANCEL: DB + Saludtools (DELETE si hay id)
                const apptId = data?.selectedCase?.appointment_id;
                const saludId = data?.selectedCase?.saludtools_appointment_id;

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

                let saludtoolsMsg =
                    "Saludtools: omitido (sin credenciales o sin ID)";

                try {
                    if (saludId) {
                        const st = await saludtoolsSyncEvent({
                            eventType: "APPOINTMENT",
                            actionType: "DELETE",
                            body: { id: String(saludId) },
                        });

                        if (st.skipped) {
                            saludtoolsMsg =
                                "Saludtools: omitido (faltan credenciales)";
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
        case "ASK_DATE": {
            if (msg === "0") return returnToInbox("↩️ Volviendo al listado");

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
            if (msg === "0") return returnToInbox("↩️ Volviendo al listado");

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
                    `Paciente: ${sel.full_name || "N/A"}\n` +
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
                                data?.selectedCase?.patient_document_type ||
                                    process.env
                                        .SALUDTOOLS_PATIENT_DOCUMENT_TYPE ||
                                    1,
                            ),
                            patientDocumentNumber: String(
                                data?.selectedCase?.patient_document_number ||
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
                            comment: `Reprogramada por secretaría. Paciente: ${data?.selectedCase?.full_name || ""}`,
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
