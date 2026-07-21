import { normalizeText } from "./utils/text.js";

import menuState from "./states/menu.state.js";
import agendarState from "./states/agendar.state.js";
import secretariaState from "./states/secretaria.state.js";
import dashboardState from "./states/dashboard.state.js";
import gestionCitasState from "./states/gestionCitas.state.js";
import soporteCitaState from "./states/soporteCita.state.js";
import postSurgeryState from "./states/postSurgery.state.js";
import { registerChatbotInteraction } from "./services/chatbot-db.service.js";

// 📌 Números autorizados como secretaría
const SECRETARY_PHONES = ["573224811542"];

/**
 * Función principal del chatbot
 */
export default async function chatbotResponse(message, session, context = {}) {
    const rawMsg = message || "";
    const msg = normalizeText(rawMsg);
    const userPhone = context.from.replace(/\D/g, "");

    let state;
    let data;

    if (SECRETARY_PHONES.includes(userPhone)) {
        state = "DASHBOARD";
        data = session.data || {};
    } else {
        state = session.state || "MENU";
        data = session.data || {};
    }

    console.log(
        "📱 Usuario:",
        userPhone,
        "| Estado:",
        state,
        "| Mensaje:",
        rawMsg,
        "| Media:",
        context.numMedia || 0,
    );

    await registerChatbotInteraction({
        phone: userPhone,
        message: rawMsg,
        state,
    });

    if (state === "DASHBOARD") {
        return dashboardState(msg, data, context);
    }

    if (state === "MENU") {
        return menuState(msg, data, context);
    }

    if (state.startsWith("AGENDAR")) {
        return agendarState(msg, data, context);
    }

    if (state === "SECRETARIA") {
        return secretariaState(msg, data, context);
    }

    if (state === "GESTION_CITAS") {
        return gestionCitasState(msg, data, context);
    }

    if (state === "SOPORTE_CITA") {
        return soporteCitaState(msg, data, context);
    }

    if (state === "POST_SURGERY" || state === "POST_SURGERY_WAIT_IMAGE") {
        return postSurgeryState(msg, data, context);
    }

    return menuState(msg, data, context);
}
