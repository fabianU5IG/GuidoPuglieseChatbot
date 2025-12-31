// util simple para slots 20 min (L–V)
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

function chatbotResponse(message, session) {
    let response = "";
    let nextState = session.state;
    let data = session.data || {};
    const msg = message.toLowerCase();

    /* ======================
     START + MENÚ
  ====================== */
    if (session.state === "START") {
        response =
            "Para tu seguridad, no compartas información clínica sensible por WhatsApp.\n" +
            "Si es una urgencia, acude a servicios de emergencia.\n\n" +
            "Soy el asistente del consultorio del Dr. Guido Pugliese.\n\n" +
            "1️⃣ Agendar cita";

        nextState = "MENU";
    } else if (session.state === "MENU") {
        if (msg === "1") {
            response = "Perfecto. Para agendar, indícame tu nombre completo.";
            nextState = "AGENDAR_NOMBRE";
        } else {
            response = "Por favor elige 1️⃣ para agendar cita.";
        }
    } else if (session.state === "AGENDAR_NOMBRE") {

    /* ======================
     NOMBRE
  ====================== */
        data.nombre = message;

        response =
            `Gracias, ${data.nombre}.\n\n` +
            "¿Es tu primera vez con el especialista?\n\n" +
            "1️⃣ Sí\n" +
            "2️⃣ No";

        nextState = "AGENDAR_PRIMERA_VEZ";
    } else if (session.state === "AGENDAR_PRIMERA_VEZ") {

    /* ======================
     PRIMERA VEZ
  ====================== */
        if (msg === "1") data.primeraVez = "Sí";
        else if (msg === "2") data.primeraVez = "No";
        else {
            response = "Elige 1️⃣ o 2️⃣.";
            return { response, nextState, data };
        }

        response =
            "Selecciona el servicio:\n\n" +
            "1️⃣ Visita Ortopedia y Traumatología\n" +
            "2️⃣ Consulta de Ortopedia y Traumatología";

        nextState = "AGENDAR_SERVICIO";
    } else if (session.state === "AGENDAR_SERVICIO") {

    /* ======================
     SERVICIO
  ====================== */
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
            "Selecciona tu aseguradora:\n\n" +
            "1️⃣ Agendo cita sin aseguradora\n" +
            "2️⃣ Colmédica\n" +
            "3️⃣ Colsanitas\n" +
            "4️⃣ Allianz\n" +
            "5️⃣ Panamerican Life";

        nextState = "AGENDAR_ASEGURADORA";
    } else if (session.state === "AGENDAR_ASEGURADORA") {

    /* ======================
     ASEGURADORA
  ====================== */
        const aseguradoras = {
            1: "Sin aseguradora",
            2: "Colmédica",
            3: "Colsanitas",
            4: "Allianz",
            5: "Panamerican Life",
        };

        if (!aseguradoras[msg]) {
            response = "Selecciona una opción válida (1 a 5).";
            return { response, nextState, data };
        }

        data.aseguradora = aseguradoras[msg];

        response =
            "Selecciona el día de tu preferencia (Lunes a Viernes).\n" +
            "Ejemplo: Lunes / Martes / Miércoles / Jueves / Viernes";

        nextState = "AGENDAR_DIA";
    } else if (session.state === "AGENDAR_DIA") {

    /* ======================
     DÍA
  ====================== */
        data.dia = message;

        const slots = getTimeSlots()
            .slice(0, 6)
            .map((h, i) => `${i + 1}️⃣ ${h}`)
            .join("\n");

        response =
            "Selecciona un horario disponible (citas de 20 minutos):\n\n" +
            slots +
            "\n\nResponde con el número.";

        nextState = "AGENDAR_HORA";
    } else if (session.state === "AGENDAR_HORA") {

    /* ======================
     HORA
  ====================== */
        const slots = getTimeSlots();
        const index = parseInt(msg) - 1;

        if (isNaN(index) || !slots[index]) {
            response = "Selecciona un número válido de horario.";
            return { response, nextState, data };
        }

        data.hora = slots[index];

        response =
            "Para confirmarte la cita, ¿este WhatsApp es tu número de contacto?\n\n" +
            "1️⃣ Sí\n" +
            "2️⃣ No";

        nextState = "AGENDAR_CONTACTO";
    } else if (session.state === "AGENDAR_CONTACTO") {

    /* ======================
     CONTACTO
  ====================== */
        if (msg === "1") {
            data.telefono = "Mismo número WhatsApp";
            nextState = "HANDOFF";
        } else if (msg === "2") {
            response = "Indícame el número de contacto.";
            nextState = "AGENDAR_TELEFONO";
            return { response, nextState, data };
        } else {
            response = "Elige 1️⃣ o 2️⃣.";
            return { response, nextState, data };
        }
    } else if (session.state === "AGENDAR_TELEFONO") {
        data.telefono = message;
        nextState = "HANDOFF";
    }

    /* ======================
     HANDOFF FINAL
  ====================== */
    if (nextState === "HANDOFF") {
        response =
            "Perfecto. Ya tengo tu solicitud de cita.\n\n" +
            "📌 Resumen:\n" +
            `Nombre: ${data.nombre}\n` +
            `Primera vez: ${data.primeraVez}\n` +
            `Servicio: ${data.servicio}\n` +
            `Aseguradora: ${data.aseguradora}\n` +
            `Día: ${data.dia}\n` +
            `Hora: ${data.hora}\n\n` +
            "La envié a secretaría para confirmación en Doctoralia.\n" +
            "Te contactarán en el próximo horario hábil.";

        nextState = "CERRADO";
    }

    return { response, nextState, data };
}

module.exports = chatbotResponse;
