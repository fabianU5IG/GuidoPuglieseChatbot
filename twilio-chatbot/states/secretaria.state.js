import { registerChatbotInteraction } from "../services/chatbot-db.service.js";

const RECEPCION_WA = "https://wa.me/573001234567";

export default async function secretariaState(msg, data, context) {
    // El usuario ya vio el mensaje en MENU
    // Aquí SOLO procesamos su respuesta

    if (msg === "1") {
        await registerChatbotInteraction({
            phone: context.from,
            appointmentId: null, // aún no se conoce
            appointmentData: {
                action: data.tipo, // REAGENDAR o CANCELAR
            },
        });

        return {
            response:
                `📲 Te redirijo a recepción:\n\n${RECEPCION_WA}\n\n` +
                "La secretaria continuará el proceso.",
            nextState: "END",
            data: {},
        };
    }

    if (msg === "2") {
        return {
            response: null,
            nextState: "MENU",
            data: { renderMenu: true },
        };
    }

    return {
        response: "Selecciona 1️⃣ o 2️⃣",
        nextState: "SECRETARIA",
        data,
    };
}
