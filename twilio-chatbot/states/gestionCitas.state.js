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

    // Primera entrada al state (cuando viene desde MENU)
    if (!data.rendered) {
        return {
            response: textoMenu,
            nextState: "GESTION_CITAS",
            data: { rendered: true },
        };
    }

    // Agendar nueva consulta
    if (msg === "1") {
        return {
            response:
                "Perfecto ✅ Vamos a iniciar el proceso de agendamiento.\n\n" +
                "Por favor escribe tu nombre completo:",
            nextState: "AGENDAR",
            data: { step: "ASK_NAME" },
        };
    }

    // Reagendar
    if (msg === "2") {
        return {
            response:
                "Para ayudarte a reagendar tu cita, por favor escribe tu número de cédula:",
            nextState: "SOPORTE_CITA",
            data: { tipo: "REAGENDAR", step: "ASK_DOCUMENT" },
        };
    }

    // Cancelar
    if (msg === "3") {
        return {
            response:
                "Para cancelar tu cita, por favor escribe tu número de cédula:",
            nextState: "SOPORTE_CITA",
            data: { tipo: "CANCELAR", step: "ASK_DOCUMENT" },
        };
    }

    // Volver al menú
    if (msg === "0") {
        return {
            response: null,
            nextState: "MENU",
            data: { renderMenu: true },
        };
    }

    // Opción inválida
    return {
        response: "❌ Opción inválida.\n\n" + textoMenu,
        nextState: "GESTION_CITAS",
        data: { rendered: true },
    };
}
