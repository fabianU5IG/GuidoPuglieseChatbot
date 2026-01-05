// Util simple para slots 20 min (L–V)
function getTimeSlots() {
    return [
        "08:00",
        "08:20",
        "08:40",
        "09:00",
        "09:20",
        "09:40",
        "10:00",
        "10:20",
        "10:40",
        "11:00",
        "11:20",
        "11:40",
        "14:00",
        "14:20",
        "14:40",
        "15:00",
        "15:20",
        "15:40",
        "16:00",
        "16:20",
        "16:40",
    ];
}

function normalizeText(s = "") {
    return String(s)
        .toLowerCase()
        .trim()
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "");
}

function isEmergency(msg) {
    const m = normalizeText(msg);
    const triggers = [
        "urgencia",
        "emergencia",
        "fractura",
        "sangrado",
        "dolor fuerte",
        "no puedo caminar",
        "accidente",
        "trauma",
        "me desmayo",
        "perdi el conocimiento",
        "hemorragia",
    ];
    return triggers.some((t) => m.includes(t));
}

function dayToKey(input) {
    const m = normalizeText(input);
    if (["lunes", "lun", "l"].includes(m)) return "Lunes";
    if (["martes", "mar", "m"].includes(m)) return "Martes";
    if (["miercoles", "miércoles", "mie", "mié", "x"].includes(m))
        return "Miércoles";
    if (["jueves", "jue", "j"].includes(m)) return "Jueves";
    if (["viernes", "vie", "v"].includes(m)) return "Viernes";
    return null;
}

function buildMainMenu() {
    return (
        "Soy el asistente del consultorio del Dr. Guido Pugliese.\n\n" +
        "¿En qué te puedo ayudar?\n\n" +
        "1️⃣ Agendar cita\n" +
        "2️⃣ Reprogramar cita\n" +
        "3️⃣ Cancelar cita\n" +
        "4️⃣ Información\n" +
        "5️⃣ Hablar con secretaría"
    );
}

function buildInfoMenu() {
    return (
        "¿Qué información necesitas?\n\n" +
        "1️⃣ Ubicación\n" +
        "2️⃣ Modalidades (presencial / en línea)\n" +
        "3️⃣ Servicios\n" +
        "4️⃣ Seguros y pagos\n" +
        "5️⃣ Preparación para la consulta\n" +
        "6️⃣ Volver al menú"
    );
}

function buildSlotsMenu(page = 0, pageSize = 6) {
    const slots = getTimeSlots();
    const start = page * pageSize;
    const slice = slots.slice(start, start + pageSize);

    const lines = slice.map((h, i) => `${i + 1}️⃣ ${h}`).join("\n");
    const hasMore = start + pageSize < slots.length;

    return (
        "Selecciona un horario disponible (citas de 20 minutos):\n\n" +
        lines +
        (hasMore ? "\n\n7️⃣ Ver más horas" : "") +
        "\n\nResponde con el número (o escribe la hora, ej: 08:20)."
    );
}

function buildAddressConfirm() {
    return (
        "Perfecto. La sede es:\n" +
        "📍 Carrera 30 #1 - 850 Porto Azul consultorio 503, Puerto Colombia.\n\n" +
        "¿Confirmas que te queda bien?\n\n" +
        "1️⃣ Sí, me queda bien\n" +
        "2️⃣ Quiero hablar con secretaría"
    );
}

function buildResumen(data) {
    const parts = [];
    parts.push("📌 Resumen de tu solicitud:");
    parts.push(`Nombre: ${data.nombre || "-"}`);
    parts.push(`Primera vez: ${data.primeraVez || "-"}`);
    parts.push(`Modalidad: ${data.modalidad || "-"}`);
    if (data.modalidad === "Visita presencial") {
        parts.push("Sede: Porto Azul consultorio 503 (Puerto Colombia)");
    }
    parts.push(`Servicio: ${data.servicio || "-"}`);
    parts.push(`Pago/Seguro: ${data.tipoPago || "-"}`);
    if (data.tipoPago === "Seguro/EPS" && data.aseguradoraTxt) {
        parts.push(`Aseguradora/EPS: ${data.aseguradoraTxt}`);
    }
    parts.push(`Día: ${data.dia || "-"}`);
    parts.push(`Hora: ${data.hora || "-"}`);
    if (data.correo) parts.push(`Correo: ${data.correo}`);
    parts.push(`Contacto: ${data.telefono || "Mismo número de WhatsApp"}`);

    return (
        parts.join("\n") +
        "\n\n¿Confirmas para enviarlo a secretaría y que lo confirmen en Doctoralia?\n\n" +
        "1️⃣ Confirmar\n" +
        "2️⃣ Cambiar datos\n" +
        "3️⃣ Hablar con secretaría"
    );
}

function buildEditarMenu() {
    return (
        "¿Qué deseas cambiar?\n\n" +
        "1️⃣ Modalidad\n" +
        "2️⃣ Servicio\n" +
        "3️⃣ Seguro / pago\n" +
        "4️⃣ Día\n" +
        "5️⃣ Hora\n" +
        "6️⃣ Contacto / correo\n" +
        "7️⃣ Volver al resumen"
    );
}

function chatbotResponse(message, session) {
    let response = "";
    let nextState = session.state || "START";
    let data = session.data || {};
    const msgRaw = String(message || "");
    const msg = normalizeText(msgRaw);

    // Emergencias / disparadores de handoff (en cualquier estado)
    if (isEmergency(msgRaw)) {
        response =
            "Entiendo. Si esto es una urgencia o presentas síntomas severos, por favor acude a un servicio de emergencias o llama a tu línea de urgencias.\n\n" +
            "Si deseas, también puedo pasar tu mensaje a secretaría.\n\n" +
            "1️⃣ Hablar con secretaría\n" +
            "2️⃣ Volver al menú";
        nextState = "EMERGENCIA_MENU";
        return { response, nextState, data };
    }

    /* ======================
     START + MENÚ
  ====================== */
    if (nextState === "START") {
        response =
            "Para tu seguridad, no compartas información clínica sensible por WhatsApp.\n" +
            "Si es una urgencia, acude a servicios de emergencia.\n\n" +
            buildMainMenu();
        nextState = "MENU";
        return { response, nextState, data };
    }

    if (nextState === "EMERGENCIA_MENU") {
        if (msg === "1") {
            response =
                "Listo. Por favor escribe en una sola frase qué necesitas (ej: ‘dolor fuerte de rodilla, necesito cita lo antes posible’) y tu nombre completo.";
            nextState = "SECRETARIA_MENSAJE";
        } else {
            response = buildMainMenu();
            nextState = "MENU";
        }
        return { response, nextState, data };
    }

    if (nextState === "MENU") {
        if (msg === "1") {
            response = "Perfecto. Para agendar, indícame tu nombre completo.";
            nextState = "AGENDAR_NOMBRE";
        } else if (msg === "2") {
            response =
                "Claro. Para reprogramar necesito ubicar tu cita.\n\n" +
                "1️⃣ Sí, la agendé por Doctoralia\n" +
                "2️⃣ No / No recuerdo\n" +
                "3️⃣ Hablar con secretaría";
            nextState = "REPRO_MENU";
        } else if (msg === "3") {
            response =
                "Entiendo. Para cancelar, por favor indícame:\n" +
                "1) Nombre y apellido\n" +
                "2) Fecha/hora de la cita (aprox.)\n\n" +
                "Escríbelo en un solo mensaje.";
            nextState = "CANCELAR_DATOS";
        } else if (msg === "4") {
            response = buildInfoMenu();
            nextState = "INFO_MENU";
        } else if (msg === "5") {
            response =
                "Claro. Por favor escribe tu solicitud para secretaría (en una sola frase) y tu nombre completo.";
            nextState = "SECRETARIA_MENSAJE";
        } else {
            response = "Por favor elige una opción:\n\n" + buildMainMenu();
        }
        return { response, nextState, data };
    }

    /* ======================
     INFO (FAQs)
  ====================== */
    if (nextState === "INFO_MENU") {
        if (msg === "1") {
            response =
                "📍 Ubicación: Carrera 30 #1 - 850 Porto Azul consultorio 503, Puerto Colombia.\n\n" +
                buildInfoMenu();
        } else if (msg === "2") {
            response =
                "Modalidades disponibles:\n" +
                "• Visita presencial\n" +
                "• Consulta en línea\n\n" +
                buildInfoMenu();
        } else if (msg === "3") {
            response =
                "Servicios:\n" +
                "1) Visita Ortopedia y Traumatología\n" +
                "2) Consulta de Ortopedia y Traumatología\n\n" +
                buildInfoMenu();
        } else if (msg === "4") {
            response =
                "Puedes agendar como Particular o por Seguro/EPS (dependiendo de disponibilidad).\n" +
                "Si me dices tu aseguradora/EPS, lo registramos para validar.\n\n" +
                buildInfoMenu();
        } else if (msg === "5") {
            response =
                "Recomendación general: lleva exámenes/imágenes previas (si tienes), lista de medicamentos y describe desde cuándo presentas el síntoma.\n\n" +
                buildInfoMenu();
        } else if (msg === "6") {
            response = buildMainMenu();
            nextState = "MENU";
            return { response, nextState, data };
        } else {
            response = "Elige una opción válida.\n\n" + buildInfoMenu();
        }
        return { response, nextState, data };
    }

    /* ======================
     REPROGRAMAR
  ====================== */
    if (nextState === "REPRO_MENU") {
        if (msg === "1" || msg === "2") {
            data.reproOrigen = msg === "1" ? "Doctoralia" : "Otro/No recuerda";
            response =
                "Por favor envíame:\n" +
                "1) Nombre y apellido\n" +
                "2) Fecha/hora actual de la cita (aprox.)\n" +
                (data.reproOrigen === "Doctoralia"
                    ? "3) Correo con el que agendaste (si aplica)\n"
                    : "") +
                "\nEscríbelo en un solo mensaje.";
            nextState = "REPRO_DATOS";
            return { response, nextState, data };
        }
        if (msg === "3") {
            response =
                "Listo. Escribe tu solicitud para secretaría (en una sola frase) y tu nombre completo.";
            nextState = "SECRETARIA_MENSAJE";
            return { response, nextState, data };
        }
        response = "Elige 1, 2 o 3.";
        return { response, nextState, data };
    }

    if (nextState === "REPRO_DATOS") {
        data.reprogramarDatos = msgRaw;
        response =
            "Gracias. ¿Qué prefieres?\n\n" +
            "1️⃣ Enviarme opciones de nuevas horas\n" +
            "2️⃣ Enviar enlace para reprogramar en Doctoralia\n" +
            "3️⃣ Que lo gestione la secretaría";
        nextState = "REPRO_ACCION";
        return { response, nextState, data };
    }

    if (nextState === "REPRO_ACCION") {
        if (msg === "1") {
            response =
                "Perfecto. Dime por favor:\n" +
                "• ¿Presencial o en línea?\n" +
                "• ¿Qué día prefieres (Lunes a Viernes)?\n\n" +
                "Ejemplo: 'Presencial, Martes'";
            nextState = "REPRO_PREFERENCIAS";
        } else if (msg === "2") {
            response =
                "Te comparto el enlace de Doctoralia para reprogramar.\n" +
                "Cuando termines, responde 'LISTO' y lo verificamos por este medio.";
            nextState = "REPRO_LISTO";
        } else if (msg === "3") {
            response =
                "Listo. Ya envié la solicitud a secretaría para que gestionen la reprogramación. Te confirmarán en el próximo horario hábil.";
            nextState = "CERRADO";
        } else {
            response = "Elige 1, 2 o 3.";
        }
        return { response, nextState, data };
    }

    if (nextState === "REPRO_PREFERENCIAS") {
        data.reproPreferencias = msgRaw;
        response =
            "Perfecto. Ya envié tus preferencias a secretaría para coordinar la reprogramación. Te confirmarán en el próximo horario hábil.";
        nextState = "CERRADO";
        return { response, nextState, data };
    }

    if (nextState === "REPRO_LISTO") {
        if (msg.includes("listo")) {
            response =
                "Gracias. Ya quedó registrado que finalizaste el proceso. Si necesitas apoyo adicional, escribe 'Secretaría' o vuelve al menú.\n\n" +
                buildMainMenu();
            nextState = "MENU";
        } else {
            response = "Cuando hayas finalizado, responde 'LISTO'.";
        }
        return { response, nextState, data };
    }

    /* ======================
     CANCELAR
  ====================== */
    if (nextState === "CANCELAR_DATOS") {
        data.cancelarDatos = msgRaw;
        response =
            "¿Confirmas que deseas cancelar la cita?\n\n" +
            "1️⃣ Sí, cancelar\n" +
            "2️⃣ No\n" +
            "3️⃣ Hablar con secretaría";
        nextState = "CANCELAR_CONFIRMAR";
        return { response, nextState, data };
    }

    if (nextState === "CANCELAR_CONFIRMAR") {
        if (msg === "1") {
            response =
                "Listo, registré la solicitud de cancelación y la envié a secretaría para confirmación.\n" +
                "Si deseas, también puedo ayudarte a agendar una nueva cita.\n\n" +
                buildMainMenu();
            nextState = "MENU";
        } else if (msg === "2") {
            response =
                "Perfecto. No realizo la cancelación.\n\n" + buildMainMenu();
            nextState = "MENU";
        } else if (msg === "3") {
            response =
                "Claro. Escribe tu solicitud para secretaría (en una sola frase) y tu nombre completo.";
            nextState = "SECRETARIA_MENSAJE";
        } else {
            response = "Elige 1, 2 o 3.";
        }
        return { response, nextState, data };
    }

    /* ======================
     SECRETARÍA (handoff)
  ====================== */
    if (nextState === "SECRETARIA_MENSAJE") {
        data.mensajeSecretaria = msgRaw;
        response =
            "Gracias. Ya envié tu mensaje a secretaría.\n" +
            "Te responderán en el próximo horario hábil.\n\n" +
            buildMainMenu();
        nextState = "MENU";
        return { response, nextState, data };
    }

    /* ======================
     AGENDAR
  ====================== */
    if (nextState === "AGENDAR_NOMBRE") {
        data.nombre = msgRaw;

        response =
            `Gracias, ${data.nombre}.\n\n` +
            "¿Es tu primera vez con el especialista?\n\n" +
            "1️⃣ Sí\n" +
            "2️⃣ No";
        nextState = "AGENDAR_PRIMERA_VEZ";
        return { response, nextState, data };
    }

    if (nextState === "AGENDAR_PRIMERA_VEZ") {
        if (msg === "1") data.primeraVez = "Sí";
        else if (msg === "2") data.primeraVez = "No";
        else {
            response = "Elige 1️⃣ o 2️⃣.";
            return { response, nextState, data };
        }

        response =
            "¿Cómo deseas tu cita?\n\n" +
            "1️⃣ Visita presencial\n" +
            "2️⃣ Consulta en línea";
        nextState = "AGENDAR_MODALIDAD";
        return { response, nextState, data };
    }

    if (nextState === "AGENDAR_MODALIDAD") {
        if (msg === "1") data.modalidad = "Visita presencial";
        else if (msg === "2") data.modalidad = "Consulta en línea";
        else {
            response = "Elige 1️⃣ o 2️⃣.";
            return { response, nextState, data };
        }

        if (data.modalidad === "Visita presencial") {
            response = buildAddressConfirm();
            nextState = "AGENDAR_DIRECCION_CONFIRMAR";
            return { response, nextState, data };
        }

        // En línea: seguir
        response =
            "Selecciona el servicio:\n\n" +
            "1️⃣ Visita Ortopedia y Traumatología\n" +
            "2️⃣ Consulta de Ortopedia y Traumatología";
        nextState = "AGENDAR_SERVICIO";
        return { response, nextState, data };
    }

    if (nextState === "AGENDAR_DIRECCION_CONFIRMAR") {
        if (msg === "1") {
            data.direccionConfirmada = "Sí";
            response =
                "Selecciona el servicio:\n\n" +
                "1️⃣ Visita Ortopedia y Traumatología\n" +
                "2️⃣ Consulta de Ortopedia y Traumatología";
            nextState = "AGENDAR_SERVICIO";
            return { response, nextState, data };
        }
        if (msg === "2") {
            response =
                "Claro. Escribe tu solicitud para secretaría (en una sola frase) y tu nombre completo.";
            nextState = "SECRETARIA_MENSAJE";
            return { response, nextState, data };
        }
        response = "Elige 1️⃣ o 2️⃣.";
        return { response, nextState, data };
    }

    if (nextState === "AGENDAR_SERVICIO") {
        const servicios = {
            1: "Visita Ortopedia y Traumatología",
            2: "Consulta de Ortopedia y Traumatología",
        };

        if (!servicios[msg]) {
            response = "Selecciona una opción válida (1 o 2).";
            return { response, nextState, data };
        }

        data.servicio = servicios[msg];

        response =
            "¿Vienes por seguro/EPS o particular?\n\n" +
            "1️⃣ Seguro/EPS\n" +
            "2️⃣ Particular\n" +
            "3️⃣ No estoy seguro/a";
        nextState = "AGENDAR_TIPO_PAGO";
        return { response, nextState, data };
    }

    if (nextState === "AGENDAR_TIPO_PAGO") {
        if (msg === "1") {
            data.tipoPago = "Seguro/EPS";
            response =
                "Perfecto. ¿Cuál es tu aseguradora/EPS? (Escríbela tal cual aparece)";
            nextState = "AGENDAR_ASEGURADORA_TEXTO";
            return { response, nextState, data };
        }
        if (msg === "2") {
            data.tipoPago = "Particular";
            response =
                "Selecciona el día de tu preferencia (Lunes a Viernes).\n" +
                "Ejemplo: Lunes / Martes / Miércoles / Jueves / Viernes";
            nextState = "AGENDAR_DIA";
            return { response, nextState, data };
        }
        if (msg === "3") {
            data.tipoPago = "No está seguro/a";
            response =
                "No hay problema. Luego lo validamos.\n\n" +
                "Selecciona el día de tu preferencia (Lunes a Viernes).\n" +
                "Ejemplo: Lunes / Martes / Miércoles / Jueves / Viernes";
            nextState = "AGENDAR_DIA";
            return { response, nextState, data };
        }

        response = "Elige 1️⃣, 2️⃣ o 3️⃣.";
        return { response, nextState, data };
    }

    if (nextState === "AGENDAR_ASEGURADORA_TEXTO") {
        data.aseguradoraTxt = msgRaw;

        response =
            "Selecciona el día de tu preferencia (Lunes a Viernes).\n" +
            "Ejemplo: Lunes / Martes / Miércoles / Jueves / Viernes";
        nextState = "AGENDAR_DIA";
        return { response, nextState, data };
    }

    if (nextState === "AGENDAR_DIA") {
        const dayKey = dayToKey(msgRaw);
        if (!dayKey) {
            response =
                "Por favor escribe un día válido (Lunes a Viernes).\n" +
                "Ejemplo: Lunes / Martes / Miércoles / Jueves / Viernes";
            return { response, nextState, data };
        }

        data.dia = dayKey;
        data.slotPage = 0;

        response = buildSlotsMenu(data.slotPage);
        nextState = "AGENDAR_HORA";
        return { response, nextState, data };
    }

    if (nextState === "AGENDAR_HORA") {
        const slots = getTimeSlots();

        // Opción: "ver más"
        if (msg === "7" && (data.slotPage || 0) * 6 + 6 < slots.length) {
            data.slotPage = (data.slotPage || 0) + 1;
            response = buildSlotsMenu(data.slotPage);
            return { response, nextState, data };
        }

        // Opción: usuario escribe la hora (08:20)
        const hourDirect = msgRaw.trim();
        if (/^\d{2}:\d{2}$/.test(hourDirect) && slots.includes(hourDirect)) {
            data.hora = hourDirect;
        } else {
            // Opción: usuario elige número 1..6 según página
            const page = data.slotPage || 0;
            const baseIndex = page * 6;
            const index = parseInt(msg, 10) - 1;

            if (isNaN(index) || index < 0 || index > 5) {
                response =
                    "Selecciona un número válido (1–6), 7 para ver más (si aplica), o escribe la hora (ej: 08:20).";
                return { response, nextState, data };
            }

            const chosen = slots[baseIndex + index];
            if (!chosen) {
                response =
                    "Ese horario no está disponible. Elige otro o escribe una hora válida (ej: 08:20).";
                return { response, nextState, data };
            }
            data.hora = chosen;
        }

        // Si primera vez, pedir correo
        if (data.primeraVez === "Sí" && !data.correo) {
            response =
                "Gracias. Como es tu primera vez, ¿me compartes tu correo para enviarte confirmación y recomendaciones previas a la cita?";
            nextState = "AGENDAR_CORREO";
            return { response, nextState, data };
        }

        response =
            "Para confirmarte la cita, ¿este WhatsApp es tu número de contacto?\n\n" +
            "1️⃣ Sí\n" +
            "2️⃣ No";
        nextState = "AGENDAR_CONTACTO";
        return { response, nextState, data };
    }

    if (nextState === "AGENDAR_CORREO") {
        data.correo = msgRaw.trim();

        response =
            "Para confirmarte la cita, ¿este WhatsApp es tu número de contacto?\n\n" +
            "1️⃣ Sí\n" +
            "2️⃣ No";
        nextState = "AGENDAR_CONTACTO";
        return { response, nextState, data };
    }

    if (nextState === "AGENDAR_CONTACTO") {
        if (msg === "1") {
            data.telefono = "Mismo número WhatsApp";
            response = buildResumen(data);
            nextState = "RESUMEN_CONFIRMAR";
            return { response, nextState, data };
        }
        if (msg === "2") {
            response = "Indícame el número de contacto.";
            nextState = "AGENDAR_TELEFONO";
            return { response, nextState, data };
        }
        response = "Elige 1️⃣ o 2️⃣.";
        return { response, nextState, data };
    }

    if (nextState === "AGENDAR_TELEFONO") {
        data.telefono = msgRaw.trim();
        response = buildResumen(data);
        nextState = "RESUMEN_CONFIRMAR";
        return { response, nextState, data };
    }

    /* ======================
     RESUMEN + EDICIÓN
  ====================== */
    if (nextState === "RESUMEN_CONFIRMAR") {
        if (msg === "1") {
            response =
                "Perfecto. Ya tengo tu solicitud de cita y la envié a secretaría para confirmación en Doctoralia.\n" +
                "Te contactarán en el próximo horario hábil.\n\n" +
                "Si necesitas cambios, puedes escribir 'Reprogramar' o volver al menú.\n\n" +
                buildMainMenu();
            nextState = "MENU";
            return { response, nextState, data };
        }
        if (msg === "2") {
            response = buildEditarMenu();
            nextState = "EDITAR_MENU";
            return { response, nextState, data };
        }
        if (msg === "3") {
            response =
                "Claro. Escribe tu solicitud para secretaría (en una sola frase) y tu nombre completo.";
            nextState = "SECRETARIA_MENSAJE";
            return { response, nextState, data };
        }

        response = "Elige 1️⃣, 2️⃣ o 3️⃣.\n\n" + buildResumen(data);
        return { response, nextState, data };
    }

    if (nextState === "EDITAR_MENU") {
        if (msg === "1") {
            response =
                "¿Cómo deseas tu cita?\n\n" +
                "1️⃣ Visita presencial\n" +
                "2️⃣ Consulta en línea";
            nextState = "AGENDAR_MODALIDAD";
            return { response, nextState, data };
        }
        if (msg === "2") {
            response =
                "Selecciona el servicio:\n\n" +
                "1️⃣ Visita Ortopedia y Traumatología\n" +
                "2️⃣ Consulta de Ortopedia y Traumatología";
            nextState = "AGENDAR_SERVICIO";
            return { response, nextState, data };
        }
        if (msg === "3") {
            response =
                "¿Vienes por seguro/EPS o particular?\n\n" +
                "1️⃣ Seguro/EPS\n" +
                "2️⃣ Particular\n" +
                "3️⃣ No estoy seguro/a";
            nextState = "AGENDAR_TIPO_PAGO";
            return { response, nextState, data };
        }
        if (msg === "4") {
            response =
                "Selecciona el día de tu preferencia (Lunes a Viernes).\n" +
                "Ejemplo: Lunes / Martes / Miércoles / Jueves / Viernes";
            nextState = "AGENDAR_DIA";
            return { response, nextState, data };
        }
        if (msg === "5") {
            data.slotPage = 0;
            response = buildSlotsMenu(0);
            nextState = "AGENDAR_HORA";
            return { response, nextState, data };
        }
        if (msg === "6") {
            response =
                "¿Qué deseas actualizar?\n\n" +
                "1️⃣ Correo\n" +
                "2️⃣ Número de contacto\n" +
                "3️⃣ Volver";
            nextState = "EDITAR_CONTACTO_MENU";
            return { response, nextState, data };
        }
        if (msg === "7") {
            response = buildResumen(data);
            nextState = "RESUMEN_CONFIRMAR";
            return { response, nextState, data };
        }

        response = "Elige una opción válida.\n\n" + buildEditarMenu();
        return { response, nextState, data };
    }

    if (nextState === "EDITAR_CONTACTO_MENU") {
        if (msg === "1") {
            response = "Escribe tu correo.";
            nextState = "EDITAR_CORREO";
            return { response, nextState, data };
        }
        if (msg === "2") {
            response = "Escribe tu número de contacto.";
            nextState = "EDITAR_TELEFONO";
            return { response, nextState, data };
        }
        if (msg === "3") {
            response = buildEditarMenu();
            nextState = "EDITAR_MENU";
            return { response, nextState, data };
        }
        response = "Elige 1, 2 o 3.";
        return { response, nextState, data };
    }

    if (nextState === "EDITAR_CORREO") {
        data.correo = msgRaw.trim();
        response = buildResumen(data);
        nextState = "RESUMEN_CONFIRMAR";
        return { response, nextState, data };
    }

    if (nextState === "EDITAR_TELEFONO") {
        data.telefono = msgRaw.trim();
        response = buildResumen(data);
        nextState = "RESUMEN_CONFIRMAR";
        return { response, nextState, data };
    }

    /* ======================
     FALLBACK GENERAL
  ====================== */
    response =
        "Para ayudarte mejor, elige una opción del menú:\n\n" + buildMainMenu();
    nextState = "MENU";
    return { response, nextState, data };
}

module.exports = chatbotResponse;
