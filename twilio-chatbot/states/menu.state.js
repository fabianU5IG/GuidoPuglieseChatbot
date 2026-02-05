export default function menuState(msg, data) {
    // RENDER FORZADO DEL MENÚ
    if (data?.renderMenu) {
        return {
            response:
                "Soy el asistente del consultorio del Dr. Guido Pugliese.\n\n" +
                "1️⃣ Agendar cita\n" +
                "2️⃣ Reagendar cita\n" +
                "3️⃣ Cancelar cita",
            nextState: "MENU",
            data: {},
        };
    }

    if (msg === "1") {
        return {
            response:
                "Vamos a iniciar el agendamiento 😊\n\n" +
                "¿Cuál es tu nombre completo?",
            nextState: "AGENDAR",
            data: { step: "ASK_NAME" },
        };
    }

    if (msg === "2") {
        return {
            response:
                "🔄 Reagendar cita\n\n" +
                "Puedes hacerlo desde Doctoralia:\n" +
                "https://www.doctoralia.co/panel-del-paciente/\n\n" +
                "1️⃣ Hablar con secretaria\n" +
                "2️⃣ Volver al menú",
            nextState: "SECRETARIA",
            data: { tipo: "REAGENDAR" },
        };
    }

    if (msg === "3") {
        return {
            response:
                "❌ Cancelar cita\n\n" +
                "Puedes hacerlo desde Doctoralia:\n" +
                "https://www.doctoralia.co/panel-del-paciente/\n\n" +
                "1️⃣ Hablar con secretaria\n" +
                "2️⃣ Volver al menú",
            nextState: "SECRETARIA",
            data: { tipo: "CANCELAR" },
        };
    }

    if (msg === "99") {
        return { response: null, nextState: "DASHBOARD", data: {} };
    }

    // DEFAULT
    return {
        response:
            "Soy el asistente del consultorio del Dr. Guido Pugliese.\n\n" +
            "1️⃣ Agendar cita\n" +
            "2️⃣ Reagendar cita\n" +
            "3️⃣ Cancelar cita",
        nextState: "MENU",
        data: {},
    };
}
