import { resolveFlowFallback } from "../services/flowFallback.service.js";

const TEMPLATE_MENU_PRINCIPAL = "HX58b32a7d0047f3359d9680ecf201c250";
const TEMPLATE_GESTION_CITA = "HXee09a2af164f7e140b257e6fbc0c061c";
const TEMPLATE_ASK_DOC_TYPE =
    process.env.TWILIO_TEMPLATE_SUPPORT_DOC_TYPE_SID ||
    process.env.TWILIO_TEMPLATE_ASK_DOC_TYPE_SID ||
    "HX56d2df1230476630f2a1edfd19b9815e";
const TEMPLATE_AGENDAMIENTO_INICIO = "HXb4e3cc876818f3affb9035fb0bd13c17";

function sendTemplate(contentSid, nextState, data = {}, variables = null) {
    return {
        response: null,
        nextState,
        data,
        sendTemplate: true,
        template: {
            contentSid,
            variables,
        },
    };
}

function normalizeOption(value = "") {
    return String(value || "")
        .trim()
        .toLowerCase()
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .replace(/[\u{1F300}-\u{1FAFF}]/gu, "")
        .replace(/[._-]+/g, " ")
        .replace(/\s+/g, " ")
        .trim();
}

function compact(value = "") {
    return normalizeOption(value).replace(/\s+/g, "_");
}

function startAppointmentSupport(tipo, data = {}) {
    // "Paciente" es solo el saludo por defecto de la plantilla cuando no
    // conocemos el nombre todavía. Antes se guardaba también en
    // `data.firstName`, y eso terminaba en la memoria de sesión (Fabian),
    // pisando el nombre real si el paciente ya se había registrado antes en
    // la misma sesión (ej: "Perfecto, Paciente. Ya tengo tus datos..." en vez
    // de su nombre real al intentar agendar otra cita después).
    const greetingName =
        data.firstName ||
        (data.fullName ? String(data.fullName).trim().split(/\s+/)[0] : null) ||
        "Paciente";

    return sendTemplate(
        TEMPLATE_ASK_DOC_TYPE,
        "SOPORTE_CITA",
        {
            ...data,
            tipo,
            step: "ASK_DOC_TYPE",
        },
        { "1": greetingName },
    );
}

export default async function gestionCitasState(msg, data = {}, context = {}) {
    const normalizedMsg = normalizeOption(msg);
    const compactMsg = compact(msg);

    if (!data.rendered && !normalizedMsg) {
        return sendTemplate(
            TEMPLATE_GESTION_CITA,
            "GESTION_CITAS",
            { rendered: true }
        );
    }

    // Payloads de botones que pueden llegar desde el menú principal.
    if (compactMsg === "menu_cita" || compactMsg === "gestionar_cita") {
        return sendTemplate(
            TEMPLATE_GESTION_CITA,
            "GESTION_CITAS",
            { rendered: true }
        );
    }

    // Agendar nueva consulta.
    if (
        normalizedMsg === "1" ||
        compactMsg === "agendar_cita" ||
        compactMsg === "agendar_nueva_consulta" ||
        compactMsg === "nueva_consulta" ||
        normalizedMsg.includes("agendar nueva") ||
        normalizedMsg.includes("nueva consulta") ||
        normalizedMsg.includes("agendar consulta") ||
        normalizedMsg === "agendar" ||
        normalizedMsg === "agendar cita"
    ) {
        return sendTemplate(TEMPLATE_AGENDAMIENTO_INICIO, "AGENDAR", {
            step: "ASK_NAME",
            origin: "CONSULTA_GENERAL",
            consultationMode: "PRESENCIAL",
            aiSchedulingEnabled: true,
        });
    }

    // Reagendar.
    if (
        normalizedMsg === "2" ||
        compactMsg === "reagendar_cita" ||
        compactMsg === "reprogramar_cita" ||
        compactMsg === "cambiar_cita" ||
        normalizedMsg.includes("reagendar") ||
        normalizedMsg.includes("reprogramar") ||
        normalizedMsg.includes("cambiar cita")
    ) {
        return startAppointmentSupport("REAGENDAR", data);
    }

    // Cancelar.
    if (
        normalizedMsg === "3" ||
        compactMsg === "cancelar_cita" ||
        compactMsg === "anular_cita" ||
        normalizedMsg.includes("cancelar") ||
        normalizedMsg.includes("anular cita")
    ) {
        return startAppointmentSupport("CANCELAR", data);
    }

    // Volver al menú.
    if (
        normalizedMsg === "0" ||
        compactMsg === "volver_menu" ||
        compactMsg === "menu_principal" ||
        normalizedMsg === "volver" ||
        normalizedMsg.includes("volver al menu") ||
        normalizedMsg.includes("volver menu") ||
        normalizedMsg.includes("menu principal") ||
        normalizedMsg === "menu"
    ) {
        return sendTemplate(TEMPLATE_MENU_PRINCIPAL, "MENU", {});
    }

    const aiFallback = await resolveFlowFallback({
        message: msg,
        currentState: "GESTION_CITAS",
        currentStep: null,
        data,
        context,
    });
    if (aiFallback) return aiFallback;

    return sendTemplate(TEMPLATE_GESTION_CITA, "GESTION_CITAS", { rendered: true });
}
