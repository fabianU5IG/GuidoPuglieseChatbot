const TEMPLATE_MENU_PRINCIPAL = "HXa378d250620cf7abd92cbb65e341801d";
const TEMPLATE_GESTION_CITA = "HX808bda7b9d8296d961d995533eb2e5eb";
const TEMPLATE_ASK_DOC_TYPE =
    process.env.TWILIO_TEMPLATE_SUPPORT_DOC_TYPE_SID ||
    process.env.TWILIO_TEMPLATE_ASK_DOC_TYPE_SID ||
    "HX3b07c0984e3fc8c6d2f96630752ef101";
const TEMPLATE_AGENDAMIENTO_INICIO = "HX1d4e991f32d11da12739d2d835110a60";

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

function startAppointmentSupport(tipo) {
    return sendTemplate(
        TEMPLATE_ASK_DOC_TYPE,
        "SOPORTE_CITA",
        {
            tipo,
            step: "ASK_DOC_TYPE",
            firstName: "Paciente",
        },
        { "1": "Paciente" },
    );
}

export default function gestionCitasState(msg, data = {}) {
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
        return startAppointmentSupport("REAGENDAR");
    }

    // Cancelar.
    if (
        normalizedMsg === "3" ||
        compactMsg === "cancelar_cita" ||
        compactMsg === "anular_cita" ||
        normalizedMsg.includes("cancelar") ||
        normalizedMsg.includes("anular cita")
    ) {
        return startAppointmentSupport("CANCELAR");
    }

    // Volver al menú.
    if (
        normalizedMsg === "0" ||
        compactMsg === "volver_menu" ||
        compactMsg === "menu_principal" ||
        normalizedMsg.includes("volver") ||
        normalizedMsg.includes("menu principal") ||
        normalizedMsg === "menu"
    ) {
        return sendTemplate(TEMPLATE_MENU_PRINCIPAL, "MENU", {});
    }

    return sendTemplate(TEMPLATE_GESTION_CITA, "GESTION_CITAS", { rendered: true });
}
