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

function hasRememberedSchedulingIdentity(memory = {}) {
    return Boolean(
        memory.fullName &&
            memory.patientDocumentType &&
            memory.patientDocumentNumber,
    );
}

function getRememberedFirstName(memory = {}) {
    if (memory.firstName) return memory.firstName;

    const fullName = String(memory.fullName || "").trim();
    return fullName ? fullName.split(/\s+/)[0] : null;
}

/**
 * Reutiliza los datos identificativos ya obtenidos en la misma sesión.
 *
 * - Si un flujo intenta comenzar AGENDAR preguntando otra vez el nombre,
 *   salta directamente a la fecha cuando ya conocemos nombre + documento.
 * - Si CANCELAR/REAGENDAR intenta pedir el documento, ejecuta directamente
 *   la consulta con el documento recordado.
 */
async function applySessionMemory(result, memory = {}, context = {}) {
    if (!result || !memory || typeof memory !== "object") return result;

    if (
        result.nextState === "AGENDAR" &&
        result.data?.step === "ASK_NAME" &&
        hasRememberedSchedulingIdentity(memory)
    ) {
        const nextData = {
            ...memory,
            ...(result.data || {}),
            step: "ASK_DATE",
        };

        // Si el usuario ya había expresado una fecha/preferencia en el mensaje
        // que inició el flujo, la procesamos de inmediato y evitamos pedirla otra vez.
        if (nextData.pendingDateInput) {
            return agendarState(nextData.pendingDateInput, nextData, context);
        }

        const rememberedFirstName = getRememberedFirstName(memory);

        return {
            response:
                `Perfecto${rememberedFirstName ? `, ${rememberedFirstName}` : ""}. Ya tengo tus datos de esta sesión. ✅\n\n` +
                "¿Para qué fecha deseas agendar la cita? Puedes escribirla como DD/MM o decirme algo como “la próxima semana en la tarde”.\n\n" +
                "0️⃣ Volver al menú",
            nextState: "AGENDAR",
            data: nextData,
        };
    }

    if (
        result.nextState === "SOPORTE_CITA" &&
        result.data?.step === "ASK_DOC_TYPE" &&
        memory.patientDocumentNumber
    ) {
        const nextData = {
            ...memory,
            ...(result.data || {}),
            patientDocumentType: Number(memory.patientDocumentType || 1),
            step: "ASK_DOCUMENT",
        };

        return soporteCitaState(
            String(memory.patientDocumentNumber),
            nextData,
            context,
        );
    }

    return result;
}

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
        // La memoria se combina con los datos del flujo, pero los datos del
        // flujo tienen prioridad. Así puede reutilizarse identidad sin mezclar
        // fechas/horas de operaciones anteriores.
        data = {
            ...(session.memory || {}),
            ...(session.data || {}),
        };
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

    let result;

    if (state === "DASHBOARD") {
        result = await dashboardState(msg, data, context);
    } else if (state === "MENU") {
        result = await menuState(msg, data, context);
    } else if (state.startsWith("AGENDAR")) {
        result = await agendarState(msg, data, context);
    } else if (state === "SECRETARIA") {
        result = await secretariaState(msg, data, context);
    } else if (state === "GESTION_CITAS") {
        result = await gestionCitasState(msg, data, context);
    } else if (state === "INFO_COSTOS") {
        result = await infoCostosState(msg, data, context);
    } else if (state === "SOPORTE_CITA") {
        result = await soporteCitaState(msg, data, context);
    } else if (
        state === "POST_SURGERY" ||
        state === "POST_SURGERY_WAIT_IMAGE"
    ) {
        result = await postSurgeryState(msg, data, context);
    } else if (state === "TELECONSULTA") {
        result = await teleconsultaState(msg, data, context);
    } else {
        result = await menuState(msg, data, context);
    }

    return applySessionMemory(result, session.memory || {}, context);
}
