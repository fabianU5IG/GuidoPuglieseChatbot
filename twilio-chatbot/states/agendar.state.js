const { getTimeSlots } = require("../utils/time");
const { buildDoctoraliaUrl } = require("../services/doctoralia.service");

function agendarState(state, msg, rawMsg, data) {
    switch (state) {
        case "AGENDAR_NOMBRE":
            data.nombre = rawMsg.trim();
            return {
                response: "¿Es tu primera vez?\n1️⃣ Sí\n2️⃣ No",
                nextState: "AGENDAR_PRIMERA_VEZ",
                data,
            };

        case "AGENDAR_PRIMERA_VEZ":
            data.primeraVez = msg === "1" ? "Sí" : "No";
            return {
                response: "¿Cómo deseas tu cita?\n1️⃣ Presencial\n2️⃣ En línea",
                nextState: "AGENDAR_MODALIDAD",
                data,
            };

        case "AGENDAR_MODALIDAD":
            data.modalidad =
                msg === "2" ? "Consulta en línea" : "Visita presencial";
            return {
                response: "Servicio:\n1️⃣ Ortopedia\n2️⃣ Consulta",
                nextState: "AGENDAR_SERVICIO",
                data,
            };

        case "AGENDAR_SERVICIO":
            data.servicio =
                msg === "2"
                    ? "Consulta de Ortopedia y Traumatología"
                    : "Visita Ortopedia y Traumatología";
            return {
                response: "📅 Ingresa la fecha de la cita (YYYY-MM-DD)",
                nextState: "AGENDAR_FECHA",
                data,
            };

        case "AGENDAR_FECHA":
            data.fechaISO = rawMsg.trim();

            const slots = getTimeSlots().slice(0, 6);

            return {
                response:
                    `⏰ ¿A qué hora deseas tu cita?\n\n` +
                    slots.map((h, i) => `${i + 1}️⃣ ${h}`).join("\n") +
                    `\n\nResponde con el número de la opción.`,
                nextState: "AGENDAR_HORA",
                data,
            };

        case "AGENDAR_HORA": {
            const offset = data.slotOffset || 0;
            const allSlots = getTimeSlots();
            const visibleSlots = allSlots.slice(offset, offset + 6);

            // ➕ Opción: Más horarios
            if (msg === "7") {
                const newOffset = offset + 6;

                if (newOffset >= allSlots.length) {
                    return {
                        response:
                            "❌ No hay más horarios disponibles.\n" +
                            "Por favor selecciona una de las opciones mostradas.",
                        nextState: "AGENDAR_HORA",
                        data,
                    };
                }

                data.slotOffset = newOffset;

                const nextSlots = allSlots.slice(newOffset, newOffset + 6);

                return {
                    response:
                        `⏰ Más horarios disponibles:\n\n` +
                        nextSlots.map((h, i) => `${i + 1}️⃣ ${h}`).join("\n") +
                        `\n7️⃣ Más horarios\n\n` +
                        `Responde con el número de la opción.`,
                    nextState: "AGENDAR_HORA",
                    data,
                };
            }

            // ⏰ Selección normal de hora
            const index = parseInt(msg, 10) - 1;
            const selectedHour = visibleSlots[index];

            if (isNaN(index) || !selectedHour) {
                return {
                    response:
                        "❌ Opción inválida.\n" +
                        "Por favor responde solo con el número correspondiente a la hora deseada.",
                    nextState: "AGENDAR_HORA",
                    data,
                };
            }

            data.hora = selectedHour;

            const url = buildDoctoraliaUrl(data.fechaISO, data.hora);

            return {
                response:
                    `Perfecto 👍\n\n` +
                    `Tu cita quedó seleccionada para:\n` +
                    `📅 Fecha: ${data.fechaISO}\n` +
                    `⏰ Hora: ${data.hora}\n\n` +
                    `Para finalizar el agendamiento, confirma aquí:\n\n` +
                    `🔗 ${url}`,
                nextState: "POST_DOCTORALIA",
                data,
            };
        }
    }
}

module.exports = agendarState;
