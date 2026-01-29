function menuState(msg, data) {
    // 1️⃣ Agendar cita (flujo normal)
    if (msg === "1") {
        return {
            response: "Perfecto. ¿Cuál es tu nombre completo?",
            nextState: "AGENDAR_NOMBRE",
            data,
        };
    }

    // 2️⃣ Reagendar cita
    if (msg === "2") {
        return {
            response:
                "🔄 Reagendar cita\n\n" +
                "Para reprogramar tu cita, Doctoralia requiere que ingreses a tu cuenta.\n\n" +
                "👉 Accede aquí:\n" +
                "https://www.doctoralia.co/panel-del-paciente/\n\n" +
                "Si tienes algún inconveniente, puedes escribirnos y te ayudamos.",
            nextState: "MENU",
            data,
        };
    }

    // 3️⃣ Cancelar cita
    if (msg === "3") {
        return {
            response:
                "❌ Cancelar cita\n\n" +
                "Para cancelar tu cita, debes hacerlo directamente desde tu cuenta de Doctoralia.\n\n" +
                "👉 Accede aquí:\n" +
                "https://www.doctoralia.co/panel-del-paciente/\n\n" +
                "Si necesitas ayuda adicional, puedes escribirnos.",
            nextState: "MENU",
            data,
        };
    }

    // Menú por defecto
    return {
        response:
            "Soy el asistente del consultorio del Dr. Guido Pugliese.\n\n" +
            "1️⃣ Agendar cita\n" +
            "2️⃣ Reagendar cita\n" +
            "3️⃣ Cancelar cita",
        nextState: "MENU",
        data,
    };
}

module.exports = menuState;
