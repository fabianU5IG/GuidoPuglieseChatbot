function chatbotResponse(message, session) {
    let response = "";
    let nextState = session.state;
    let attempts = session.attempts || 0;
    let data = session.data || {};

    const msg = message.toLowerCase();

    // ======================
    // START / BIENVENIDA
    // ======================
    if (session.state === "START") {
        response =
            "Para tu seguridad, no compartas información clínica sensible por WhatsApp.\n" +
            "Si es una urgencia, acude a los servicios de emergencia de tu ciudad.\n\n" +
            "Soy el asistente del consultorio del Dr. Guido Pugliese.\n" +
            "¿En qué te puedo ayudar hoy?\n\n" +
            "1️⃣ Agendar cita\n" +
            "2️⃣ Reprogramar cita\n" +
            "3️⃣ Cancelar cita\n" +
            "4️⃣ Información";

        nextState = "MENU";
    }

    // ======================
    // MENU PRINCIPAL
    // ======================
    else if (session.state === "MENU") {
        if (msg === "1") {
            response = "Perfecto. Para agendar, indícame tu nombre completo.";
            nextState = "AGENDAR_NOMBRE";
        } else if (msg === "2") {
            response = "Claro. Para reprogramar, indícame tu nombre completo.";
            nextState = "REPROGRAMAR_NOMBRE";
        } else if (msg === "3") {
            response = "Entendido. Para cancelar, indícame tu nombre completo.";
            nextState = "CANCELAR_NOMBRE";
        } else if (msg === "4") {
            response =
                "¿Qué información necesitas?\n\n" +
                "1️⃣ Ubicación\n" +
                "2️⃣ Horarios\n" +
                "3️⃣ Medios de pago\n" +
                "4️⃣ Hablar con secretaría\n" +
                "5️⃣ Volver al menú";
            nextState = "INFO_MENU";
        } else {
            response =
                "Para ayudarte más rápido, elige una opción del menú:\n" +
                "1️⃣ Agendar\n2️⃣ Reprogramar\n3️⃣ Cancelar\n4️⃣ Información";
        }
    }

    // ======================
    // INFORMACIÓN (FAQ)
    // ======================
    else if (session.state === "INFO_MENU") {
        if (msg === "1") {
            response =
                "Estamos ubicados en: [DIRECCIÓN DEL CONSULTORIO].\n\n" +
                "1️⃣ Ver en Google Maps\n" +
                "2️⃣ Volver al menú";
            nextState = "INFO_UBICACION";
        } else if (msg === "2") {
            response =
                "Horario de atención:\n[LUNES A VIERNES – HORARIO].\n\n" +
                "1️⃣ Agendar cita\n" +
                "2️⃣ Volver";
            nextState = "INFO_HORARIOS";
        } else if (msg === "3") {
            response =
                "Medios de pago:\nEfectivo / Tarjetas / Transferencia.\n\n" +
                "1️⃣ Agendar cita\n" +
                "2️⃣ Volver";
            nextState = "INFO_PAGOS";
        } else if (msg === "4") {
            response =
                "Te paso con secretaría para ayudarte directamente.\n" +
                "Te responderán en el próximo horario hábil.";
            nextState = "HANDOFF";
        } else if (msg === "5") {
            nextState = "START";
            response = "Volviendo al menú principal…";
        } else {
            response = "Por favor elige una opción válida del menú.";
        }
    }

    // ======================
    // AGENDAR CITA
    // ======================
    else if (session.state === "AGENDAR_NOMBRE") {
        data.nombre = message;
        response =
            `Gracias, ${data.nombre}.\n¿Qué tipo de cita necesitas?\n\n` +
            "1️⃣ Primera vez\n" +
            "2️⃣ Control / seguimiento\n" +
            "3️⃣ No estoy seguro(a)";
        nextState = "AGENDAR_TIPO";
    } else if (session.state === "AGENDAR_TIPO") {
        data.tipoCita = message;
        response =
            "¿Tienes preferencia de fecha u horario?\n\n" +
            "1️⃣ Esta semana\n" +
            "2️⃣ Próxima semana\n" +
            "3️⃣ En la mañana\n" +
            "4️⃣ En la tarde\n" +
            "5️⃣ Me es indiferente";
        nextState = "AGENDAR_PREFERENCIA";
    } else if (session.state === "AGENDAR_PREFERENCIA") {
        data.preferencia = message;
        response =
            "Perfecto. Ya tengo tu solicitud.\n" +
            "La estoy enviando a secretaría para confirmarte la cita.\n\n" +
            "Te responderán lo antes posible en el próximo horario hábil.";
        nextState = "HANDOFF";
    }

    // ======================
    // REPROGRAMAR
    // ======================
    else if (session.state === "REPROGRAMAR_NOMBRE") {
        data.nombre = message;
        response =
            "¿Recuerdas la fecha y hora actual de la cita?\n\n" +
            "1️⃣ Sí\n" +
            "2️⃣ No";
        nextState = "REPROGRAMAR_RECUERDA";
    } else if (session.state === "REPROGRAMAR_RECUERDA") {
        if (msg === "1") {
            response = "Indícame la fecha y hora actual, por favor.";
            nextState = "REPROGRAMAR_FECHA";
        } else {
            response = "No hay problema. Te paso con secretaría para ayudarte.";
            nextState = "HANDOFF";
        }
    } else if (session.state === "REPROGRAMAR_FECHA") {
        data.fechaActual = message;
        response =
            "Para validar tu solicitud, indícame los últimos 2 dígitos de tu documento.";
        nextState = "REPROGRAMAR_VALIDACION";
    } else if (session.state === "REPROGRAMAR_VALIDACION") {
        if (/^\d{2}$/.test(message)) {
            response =
                "Gracias. Ya envié tu solicitud de reprogramación a secretaría.";
            nextState = "HANDOFF";
        } else {
            attempts++;
            if (attempts >= 2) {
                response =
                    "No pude validar la información. Te paso con secretaría.";
                nextState = "HANDOFF";
            } else {
                response =
                    "El dato no es válido. Intenta nuevamente con los últimos 2 dígitos.";
            }
        }
    }

    // ======================
    // CANCELAR
    // ======================
    else if (session.state === "CANCELAR_NOMBRE") {
        data.nombre = message;
        response =
            "¿Recuerdas la fecha y hora de la cita?\n\n" + "1️⃣ Sí\n" + "2️⃣ No";
        nextState = "CANCELAR_RECUERDA";
    } else if (session.state === "CANCELAR_RECUERDA") {
        if (msg === "1") {
            response = "Indícame la fecha y hora, por favor.";
            nextState = "CANCELAR_FECHA";
        } else {
            response = "No hay problema. Te paso con secretaría para ayudarte.";
            nextState = "HANDOFF";
        }
    } else if (session.state === "CANCELAR_FECHA") {
        data.fecha = message;
        response =
            "Para confirmar, indícame los últimos 2 dígitos de tu documento.";
        nextState = "CANCELAR_VALIDACION";
    } else if (session.state === "CANCELAR_VALIDACION") {
        if (/^\d{2}$/.test(message)) {
            response =
                "Gracias. Ya envié tu solicitud de cancelación a secretaría.";
            nextState = "HANDOFF";
        } else {
            response =
                "No pude validar la información. Te paso con secretaría.";
            nextState = "HANDOFF";
        }
    }

    // ======================
    // HANDOFF
    // ======================
    else if (session.state === "HANDOFF") {
        response =
            "Este caso fue escalado a secretaría.\n" +
            "Te contactarán lo antes posible.\n\n" +
            "Gracias por comunicarte con el consultorio.";
        nextState = "CERRADO";
    }

    // ======================
    // DEFAULT
    // ======================
    else {
        response =
            "Para ayudarte más rápido, vuelve al menú principal.\n" +
            "Escribe cualquier mensaje para comenzar.";
        nextState = "START";
    }

    return {
        response,
        nextState,
        attempts,
        data,
    };
}

module.exports = chatbotResponse;
