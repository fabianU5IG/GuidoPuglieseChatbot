import timeUtils from "../utils/time.js";
import { buildDoctoraliaUrl } from "../services/doctoralia.service.js";
import {
    getPendingCases,
    markCancelled,
    markReScheduled,
    registerChatbotInteraction,
} from "../services/chatbot-db.service.js";

const { getTimeSlots } = timeUtils;

const SECRETARY_PHONES = ["573153573131"];

const SLOT_IDS = {
    VISITA: 287224,
    CONSULTA: 287248,
};

function isValidDateDDMM(value) {
    if (!/^\d{2}\/\d{2}$/.test(value)) return false;

    const [day, month] = value.split("/").map(Number);
    const year = new Date().getFullYear();
    const date = new Date(year, month - 1, day);
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    return !isNaN(date) && date >= today;
}

export default async function dashboardState(msg, data, context) {
    const from = context.from.replace(/\D/g, "");

    if (!SECRETARY_PHONES.includes(from)) {
        return {
            response: "❌ Acceso no autorizado.",
            nextState: "MENU",
            data: {},
        };
    }

    if (!data.step) data.step = "INBOX";

    switch (data.step) {
        /* =========================
           INBOX
        ========================= */
        case "INBOX": {
            const cases = await getPendingCases();

            if (!cases.length) {
                return {
                    response:
                        "📋 Dashboard Secretaría\n\n" +
                        "No hay casos pendientes.\n\n" +
                        "0️⃣ Salir",
                    nextState: "DASHBOARD",
                    data,
                };
            }

            let response = "📋 Casos pendientes:\n\n";

            cases.forEach((c, i) => {
                response +=
                    `${i + 1}️⃣ ${c.full_name || "Paciente"}\n` +
                    `📞 ${c.phone}\n` +
                    `🕒 ${new Date(c.last_update).toLocaleString()}\n\n`;
            });

            response += "Selecciona un caso o escribe 0️⃣ para salir";

            data.cases = cases;
            data.step = "SELECT_CASE";

            return { response, nextState: "DASHBOARD", data };
        }

        /* =========================
           SELECT CASE
        ========================= */
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

            data.selectedCase = data.cases[index];
            data.step = "CASE_ACTIONS";

            return {
                response:
                    `🔔 Caso seleccionado\n\n` +
                    `Paciente: ${data.selectedCase.full_name}\n` +
                    `Tel: ${data.selectedCase.phone}\n\n` +
                    `1️⃣ Reagendar\n` +
                    `2️⃣ Cancelar\n` +
                    `0️⃣ Volver`,
                nextState: "DASHBOARD",
                data,
            };
        }

        /* =========================
           CASE ACTIONS
        ========================= */
        case "CASE_ACTIONS":
            if (msg === "0") {
                return {
                    response: "↩️ Volviendo al listado",
                    nextState: "DASHBOARD",
                    data: { step: "INBOX" },
                };
            }

            if (msg === "1") {
                data.step = "ASK_DATE";
                return {
                    response:
                        "🔄 Reagendar cita\n\n" +
                        "Ingresa la nueva fecha (DD/MM):",
                    nextState: "DASHBOARD",
                    data,
                };
            }

            if (msg === "2") {
                await markCancelled(data.selectedCase.appointment_id);

                await registerChatbotInteraction({
                    phone: from,
                    appointmentId: data.selectedCase.appointment_id,
                    appointmentData: { newStatus: "CANCELLED" },
                });

                data.step = "AFTER_ACTION";

                return {
                    response:
                        "❌ Cita marcada como *CANCELADA*\n\n" +
                        "1️⃣ Terminar\n" +
                        "2️⃣ Volver al dashboard",
                    nextState: "DASHBOARD",
                    data,
                };
            }

            return {
                response: "❌ Opción inválida",
                nextState: "DASHBOARD",
                data,
            };

        /* =========================
           REAGENDAR – FECHA
        ========================= */
        case "ASK_DATE":
            if (!isValidDateDDMM(msg)) {
                return {
                    response:
                        "❌ Fecha inválida. Usa formato DD/MM y fecha futura.",
                    nextState: "DASHBOARD",
                    data,
                };
            }

            data.date = msg;
            data.page = 0;
            data.step = "ASK_TIME";
            return buildTimeResponse(data);

        /* =========================
           REAGENDAR – HORA
        ========================= */
        case "ASK_TIME":
            if (msg === "7") {
                data.page++;
                return buildTimeResponse(data);
            }

            const slots = getTimeSlots(data.page);
            const indexTime = parseInt(msg, 10) - 1;
            const hour = slots[indexTime];

            if (!hour) {
                return {
                    response: "❌ Opción inválida.",
                    nextState: "DASHBOARD",
                    data,
                };
            }

            data.time = hour;
            data.step = "ASK_TYPE";

            return {
                response: "¿Qué tipo de atención?\n\n1️⃣ Visita\n2️⃣ Consulta",
                nextState: "DASHBOARD",
                data,
            };

        /* =========================
           REAGENDAR – TIPO
        ========================= */
        case "ASK_TYPE":
            if (msg === "1") {
                data.slotId = SLOT_IDS.VISITA;
                data.attentionType = "Visita";
            } else if (msg === "2") {
                data.slotId = SLOT_IDS.CONSULTA;
                data.attentionType = "Consulta";
            } else {
                return {
                    response: "Selecciona 1️⃣ o 2️⃣",
                    nextState: "DASHBOARD",
                    data,
                };
            }

            data.redirectUrl = buildDoctoraliaUrl(
                data.date,
                data.time,
                data.slotId,
            );

            await markReScheduled(data.selectedCase.appointment_id);

            await registerChatbotInteraction({
                phone: from,
                appointmentId: data.selectedCase.appointment_id,
                appointmentData: { newStatus: "RESCHEDULED" },
            });

            data.step = "AFTER_ACTION";

            return {
                response:
                    `🗓️ Reagendación lista\n\n` +
                    `Paciente: ${data.selectedCase.full_name}\n` +
                    `Tipo: *${data.attentionType}*\n\n` +
                    `Link para el paciente:\n\n${data.redirectUrl}\n\n` +
                    `1️⃣ Terminar\n2️⃣ Volver al dashboard`,
                nextState: "DASHBOARD",
                data,
            };

        /* =========================
           AFTER ACTION
        ========================= */
        case "AFTER_ACTION":
            if (msg === "1") {
                return {
                    response: "✅ Proceso finalizado",
                    nextState: "END",
                    data: {},
                };
            }

            if (msg === "2") {
                return {
                    response: null,
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
}

function buildTimeResponse(data) {
    const slots = getTimeSlots(data.page);
    let response = "Horas disponibles:\n\n";

    slots.forEach((h, i) => {
        response += `${i + 1}️⃣ ${h}\n`;
    });

    if (getTimeSlots(data.page + 1).length) {
        response += "\n7️⃣ Más horarios";
    }

    return { response, nextState: "DASHBOARD", data };
}
