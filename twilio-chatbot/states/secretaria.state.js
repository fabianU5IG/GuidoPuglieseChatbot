import { registerChatbotInteraction } from "../services/chatbot-db.service.js";

const RECEPCION_WA = "https://wa.me/573001234567";

export default async function secretariaState(msg, data, context) {
    if (msg === "1" && data.appointmentId) {
        await registerChatbotInteraction({
            phone: context.from,
            appointmentId: data.appointmentId,
            appointmentData: { newStatus: "REDIRECTED" },
        });

        return {
            response:
                `📲 Te redirijo a recepción:\n\n${RECEPCION_WA}\n\n` +
                `La secretaria continuará el proceso.`,
            nextState: "END",
            data: {},
        };
    }

    return {
        response:
            "¿Qué deseas hacer?\n\n" +
            "1️⃣ Hablar con secretaría\n" +
            "2️⃣ Volver al menú",
        nextState: "SECRETARIA",
        data,
    };
}
