import { normalizeText } from "./utils/text.js";

import menuState from "./states/menu.state.js";
import agendarState from "./states/agendar.state.js";
import secretariaState from "./states/secretaria.state.js";
import dashboardState from "./states/dashboard.state.js";
import gestionCitasState from "./states/gestionCitas.state.js";
import soporteCitaState from "./states/soporteCita.state.js";
import postSurgeryState from "./states/postSurgery.state.js";
import teleconsultaState from "./states/teleconsulta.state.js";
import infoCostosState from "./states/infoCostos.state.js";
import { registerChatbotInteraction } from "./services/chatbot-db.service.js";
import { SECRETARY_PHONES } from "./constants.js";

/**
 * Función principal del chatbot
 */
export default async function chatbotResponse(message, session, context = {}) {
    const rawMsg = message || "";
    const msg = normalizeText(rawMsg);
    const userPhone = context.from.replace(/\D/g, "");

    let state;
    let data;

    const isSecretary = SECRETARY_PHONES.includes(userPhone);
    const dashboardIntent = [
        "dashboard",
        "panel",
        "panel secretaria",
        "panel de secretaria",
    ].includes(msg);

    if (isSecretary && (session.isNew || dashboardIntent)) {
        state = "DASHBOARD";
        data = { step: "MENU" };
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

    try {
        // Se usa context.from (mismo formato "+<código><número>" que usan todos los
        // estados para leer/guardar el paciente) y no userPhone, para no crear un
        // registro de paciente duplicado por una diferencia de formato del teléfono.
        await registerChatbotInteraction({
            phone: context.from,
            message: rawMsg,
            state,
        });
    } catch (error) {
        console.error("❌ No fue posible registrar la interacción en la BD:", error);
    }

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

    if (state === "INFO_COSTOS") {
        return infoCostosState(msg, data, context);
    }

    if (state === "SOPORTE_CITA") {
        return soporteCitaState(msg, data, context);
    }

    if (state === "POST_SURGERY" || state === "POST_SURGERY_WAIT_IMAGE") {
        return postSurgeryState(msg, data, context);
    }

    if (state === "TELECONSULTA") {
        return teleconsultaState(msg, data, context);
    }

    return menuState(msg, data, context);
}
