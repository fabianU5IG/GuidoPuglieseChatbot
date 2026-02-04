const RECEPCION_WA = "https://wa.me/573001234567";

const TEXTOS = {
    REAGENDAR: {
        titulo: "🔄 Reagendar cita",
        waText: "Hola, quiero reagendar mi cita",
    },
    CANCELAR: {
        titulo: "❌ Cancelar cita",
        waText: "Hola, quiero cancelar mi cita",
    },
};

export default function soporteCitaState(msg, data) {
    const tipo = data.tipo; // "REAGENDAR" | "CANCELAR"
    const config = TEXTOS[tipo];

    if (!config) {
        return {
            response: "❌ Ocurrió un error. Volviendo al menú.",
            nextState: "MENU",
            data: {},
        };
    }

    if (msg === "1") {
        const url = `${RECEPCION_WA}?text=` + encodeURIComponent(config.waText);

        return {
            response: `📲 Te estoy redirigiendo a recepción:\n\n${url}`,
            nextState: "END",
            data: {},
        };
    }

    if (msg === "2") {
        return {
            response: null,
            nextState: "MENU",
            data: {},
        };
    }

    return {
        response:
            `${config.titulo}\n\n` +
            "1️⃣ Hablar con secretaria\n" +
            "2️⃣ Volver al menú",
        nextState: "SOPORTE_CITA",
        data,
    };
}
