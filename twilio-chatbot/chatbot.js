import { normalizeText } from "./utils/text.js";

import menuState from "./states/menu.state.js";
import agendarState from "./states/agendar.state.js";
import secretariaState from "./states/secretaria.state.js";
import postDoctoraliaState from "./states/postDoctoralia.state.js";
import dashboardState from "./states/dashboard.state.js";

import { registerChatbotInteraction } from "./services/chatbot-db.service.js";

// 📌 Números autorizados como secretaría
const SECRETARY_PHONES = [
    "573153573131", // 👈 reemplaza por el real
];

/**
 * Función principal del chatbot
 */
export default async function chatbotResponse(message, session, context = {}) {
    const rawMsg = message || "";
    const msg = normalizeText(rawMsg);

    //const userPhone = context.from;
    const userPhone = context.from.replace(/\D/g, "");
    let state = session.state || "MENU";
    let data = session.data || {};
    console.log(
        "📱 Usuario:",
        userPhone,
        "| Estado:",
        state,
        "| Mensaje:",
        rawMsg,
    );
    // 🔐 FORZAR DASHBOARD PARA SECRETARÍA
    if (SECRETARY_PHONES.includes(userPhone)) {
        state = "DASHBOARD";
    }

    // 🔹 Registro centralizado en DB
    await registerChatbotInteraction({
        phone: userPhone,
        message: rawMsg,
        state,
    });

    // 🔹 Enrutamiento por estado
    if (state === "DASHBOARD") {
        return dashboardState(msg, data, context);
    }

    if (state === "MENU") {
        return menuState(msg, data);
    }

    if (state.startsWith("AGENDAR")) {
        return agendarState(msg, data, context);
    }

    if (state === "POST_DOCTORALIA") {
        return postDoctoraliaState(msg, data);
    }

    if (state === "SECRETARIA") {
        return secretariaState(rawMsg, data);
    }

    // 🔁 Fallback seguro
    return menuState(msg, data);
}
