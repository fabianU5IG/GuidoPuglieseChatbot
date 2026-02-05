import timeUtils from "../utils/time.js";
import { buildDoctoraliaUrl } from "../services/doctoralia.service.js";
import { createFinalAppointment } from "../services/chatbot-db.service.js";

const { getTimeSlots } = timeUtils;

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

export default async function agendarState(msg, data, context) {
    const phone = context.from;

    if (!data.step) {
        data.step = "ASK_NAME";
        return {
            response:
                "Vamos a iniciar el agendamiento 😊\n\n¿Cuál es tu nombre completo?",
            nextState: "AGENDAR",
            data,
        };
    }

    switch (data.step) {
        case "ASK_NAME":
            if (msg.length < 3) {
                return {
                    response: "Por favor ingresa tu nombre completo 😊",
                    nextState: "AGENDAR",
                    data,
                };
            }

            data.fullName = msg;
            data.firstName = msg.split(" ")[0];
            data.step = "ASK_DATE";

            return {
                response: `Gracias, ${data.firstName} 😊\n\n¿Para qué fecha deseas agendar la cita?\n(DD/MM)`,
                nextState: "AGENDAR",
                data,
            };

        case "ASK_DATE":
            if (!isValidDateDDMM(msg)) {
                return {
                    response: "❌ Fecha inválida.\nDebe ser DD/MM y futura.",
                    nextState: "AGENDAR",
                    data,
                };
            }

            data.date = msg;
            data.page = 0;
            data.step = "ASK_TIME";
            return buildTimeResponse(data);

        case "ASK_TIME":
            if (msg === "7") {
                data.page++;
                return buildTimeResponse(data);
            }

            const index = parseInt(msg, 10) - 1;
            const slots = getTimeSlots(data.page);
            const hour = slots[index];

            if (!hour) {
                return {
                    response: "❌ Opción inválida.",
                    nextState: "AGENDAR",
                    data,
                };
            }

            data.time = hour;
            data.step = "ASK_TYPE";

            return {
                response:
                    "¿Qué tipo de atención deseas?\n\n1️⃣ Visita\n2️⃣ Consulta",
                nextState: "AGENDAR",
                data,
            };

        case "ASK_TYPE":
            if (msg === "1") {
                data.slotId = SLOT_IDS.VISITA;
                data.attentionType = "Visita";
            } else if (msg === "2") {
                data.slotId = SLOT_IDS.CONSULTA;
                data.attentionType = "Consulta";
            } else {
                return {
                    response:
                        "Selecciona una opción válida:\n1️⃣ Visita\n2️⃣ Consulta",
                    nextState: "AGENDAR",
                    data,
                };
            }

            data.redirectUrl = buildDoctoraliaUrl(
                data.date,
                data.time,
                data.slotId,
            );

            data.step = "POST_REDIRECT";

            return {
                response:
                    `Perfecto ${data.firstName} 🗓️\n\n` +
                    `Tipo: *${data.attentionType}*\n\n` +
                    `Finaliza tu agendamiento aquí:\n\n${data.redirectUrl}\n\n` +
                    `1️⃣ Ya terminé\n2️⃣ Quiero hacer otra solicitud`,
                nextState: "AGENDAR",
                data,
            };

        case "POST_REDIRECT":
            if (msg === "1") {
                await createFinalAppointment({
                    phone,
                    fullName: data.fullName,
                    date: data.date,
                    time: data.time,
                    status: "CONFIRMED",
                });

                return {
                    response:
                        `✅ ¡Listo ${data.firstName}!\n\n` +
                        "Tu cita quedó registrada.\nQue tengas un excelente día 😊",
                    nextState: "MENU",
                    data: {},
                };
            }

            if (msg === "2") {
                return {
                    response:
                        "Soy el asistente del consultorio del Dr. Guido Pugliese.\n\n" +
                        "1️⃣ Agendar cita\n" +
                        "2️⃣ Reagendar cita\n" +
                        "3️⃣ Cancelar cita",
                    nextState: "MENU",
                    data: {},
                };
            }

            return {
                response: "Responde 1️⃣ o 2️⃣",
                nextState: "AGENDAR",
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

    return { response, nextState: "AGENDAR", data };
}
