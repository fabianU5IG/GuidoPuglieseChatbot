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

export default async function dashboardState(msg, data = {}, context) {
    console.log("📊 Entrando a DASHBOARD");
    console.log("Step actual:", data?.step);

    const from = context.from.replace(/\D/g, "");

    if (!SECRETARY_PHONES.includes(from)) {
        return {
            response: "❌ Acceso no autorizado.",
            nextState: "MENU",
            data: {},
        };
    }

    if (!data.step) {
        data.step = "INBOX";
    }

    switch (data.step) {
        /* =========================
           INBOX
        ========================= */
        case "INBOX": {
            let cases = [];

            try {
                cases = await getPendingCases();
            } catch (err) {
                console.error("❌ Error getPendingCases:", err);
            }

            if (!Array.isArray(cases)) {
                console.log("⚠️ getPendingCases devolvió:", cases);
                cases = [];
            }

            console.log("📋 Casos encontrados:", cases.length);

            if (cases.length === 0) {
                return {
                    response:
                        "📋 Dashboard Secretaría\n\n" +
                        "No hay casos pendientes.\n\n" +
                        "0️⃣ Salir",
                    nextState: "DASHBOARD",
                    data: { step: "INBOX" },
                };
            }

            let response = "📋 Casos pendientes:\n\n";

            cases.slice(0, 10).forEach((c, i) => {
                let formattedDate = "Sin fecha";

                if (c.last_update) {
                    const d = new Date(c.last_update);
                    if (!isNaN(d)) {
                        formattedDate = d.toLocaleString();
                    }
                }

                response +=
                    `${i + 1}️⃣ ${c.full_name || "Paciente"}\n` +
                    `📞 ${c.phone || "Sin teléfono"}\n` +
                    `🕒 ${formattedDate}\n\n`;
            });

            if (cases.length > 10) {
                response += "\n... Mostrando primeros 10 casos\n";
            }

            response += "\nSelecciona un caso o escribe 0️⃣ para salir";

            return {
                response,
                nextState: "DASHBOARD",
                data: {
                    step: "SELECT_CASE",
                    cases,
                },
            };
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

            const selectedCase = data.cases[index];

            return {
                response:
                    `🔔 Caso seleccionado\n\n` +
                    `Paciente: ${selectedCase.full_name}\n` +
                    `Tel: ${selectedCase.phone}\n\n` +
                    `1️⃣ Reagendar\n` +
                    `2️⃣ Cancelar\n` +
                    `0️⃣ Volver`,
                nextState: "DASHBOARD",
                data: {
                    step: "CASE_ACTIONS",
                    selectedCase,
                },
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
                return {
                    response:
                        "🔄 Reagendar cita\n\n" +
                        "Ingresa la nueva fecha (DD/MM):",
                    nextState: "DASHBOARD",
                    data: { ...data, step: "ASK_DATE" },
                };
            }

            if (msg === "2") {
                try {
                    await markCancelled(data.selectedCase.appointment_id);

                    await registerChatbotInteraction({
                        phone: from,
                        appointmentId: data.selectedCase.appointment_id,
                        appointmentData: { newStatus: "CANCELLED" },
                    });
                } catch (err) {
                    console.error("❌ Error cancelando:", err);
                }

                return {
                    response:
                        "❌ Cita marcada como *CANCELADA*\n\n" +
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

        default:
            return {
                response: "⚠️ Reiniciando dashboard...",
                nextState: "DASHBOARD",
                data: { step: "INBOX" },
            };
    }
}
