function normalizeOption(value = "") {
    return String(value || "")
        .trim()
        .toLowerCase()
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .replace(/[\u{1F300}-\u{1FAFF}]/gu, "")
        .replace(/[_-]+/g, " ")
        .replace(/\s+/g, " ")
        .trim();
}

export default function gestionCitasState(msg, data = {}) {
    const textoMenu =
        "Antes de continuar, ten en cuenta:\n\n" +
        "• El Dr. no es ortopedista pediátrico.\n" +
        "• No realizamos consultas domiciliarias.\n" +
        "• Nos enfocamos principalmente en problemas de columna.\n" +
        "• No prestamos servicio de urgencias.\n\n" +
        "Selecciona una opción:\n\n" +
        "1️⃣ Agendar nueva consulta\n" +
        "2️⃣ Reagendar cita\n" +
        "3️⃣ Cancelar cita\n" +
        "0️⃣ Volver al menú principal";

    const normalizedMsg = normalizeOption(msg);

    // Solo renderiza texto si el estado se abre sin venir de template.
    // Cuando llega desde el template HX4148..., data.rendered ya viene true.
    if (!data.rendered && !normalizedMsg) {
        return {
            response: textoMenu,
            nextState: "GESTION_CITAS",
            data: { rendered: true },
        };
    }

    // Agendar nueva consulta
    if (
        normalizedMsg === "1" ||
        normalizedMsg.includes("agendar nueva") ||
        normalizedMsg.includes("nueva consulta") ||
        normalizedMsg.includes("agendar consulta") ||
        normalizedMsg === "agendar" ||
        normalizedMsg === "agendar cita" ||
        normalizedMsg === "agendar nueva consulta"
    ) {
        return {
            response:
                "Perfecto ✅ Vamos a iniciar el proceso de agendamiento.\n\n" +
                "Por favor escribe tu nombre completo:",
            nextState: "AGENDAR",
            data: { step: "ASK_NAME" },
        };
    }

    // Reagendar
    if (
        normalizedMsg === "2" ||
        normalizedMsg.includes("reagendar") ||
        normalizedMsg.includes("reprogramar") ||
        normalizedMsg.includes("cambiar cita")
    ) {
        return {
            response: "Para ayudarte a reagendar tu cita, por favor escribe tu número de cédula:",
            nextState: "SOPORTE_CITA",
            data: { tipo: "REAGENDAR", step: "ASK_DOCUMENT" },
        };
    }

    // Cancelar
    if (
        normalizedMsg === "3" ||
        normalizedMsg.includes("cancelar") ||
        normalizedMsg.includes("anular cita")
    ) {
        return {
            response: "Para cancelar tu cita, por favor escribe tu número de cédula:",
            nextState: "SOPORTE_CITA",
            data: { tipo: "CANCELAR", step: "ASK_DOCUMENT" },
        };
    }

    // Volver al menú
    if (
        normalizedMsg === "0" ||
        normalizedMsg.includes("volver") ||
        normalizedMsg.includes("menu principal") ||
        normalizedMsg === "menu"
    ) {
        return {
            response: null,
            nextState: "MENU",
            data: { renderMenu: true },
        };
    }

    return {
        response: "❌ Opción inválida.\n\n" + textoMenu,
        nextState: "GESTION_CITAS",
        data: { rendered: true },
    };
}
