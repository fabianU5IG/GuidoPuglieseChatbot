import gestionCitasState from "./gestionCitas.state.js";

export default function menuState(msg, data) {
    const mainMenu =
        "Hola 👋\n\n" +
        "Soy el asistente del consultorio del Dr. Guido Pugliese, Ortopedista – Traumatólogo.\n\n" +
        "¿En qué puedo ayudarte hoy?\n\n" +
        "1️⃣ Agendar o gestionar mi cita\n" +
        "2️⃣ Información general y costos\n" +
        "3️⃣ Teleconsulta (lectura de estudios)\n" +
        "4️⃣ Soy paciente postquirúrgico\n" +
        "5️⃣ Hablar con la secretaria";

    // Si el usuario escribe hola, responder con texto normal.
    if (msg.toLowerCase() === "hola") {
        return {
            response: null,
            nextState: "MENU",
            data: {},
            sendTemplate: true,
            template: {
                contentSid: "HXa378d250620cf7abd92cbb65e341801d",
                variables: null,
            },
        };
    }

    // Render forzado
    if (data?.renderMenu) {
        return { response: mainMenu, nextState: "MENU", data: {} };
    }

    switch (msg) {
        case "1":
            return gestionCitasState("", {});

        case "2":
            return {
                response:
                    "💰 Consulta particular: $400.000\n\n" +
                    "• Los descuentos los autoriza directamente el Dr.\n" +
                    "• Los controles continuos pueden tener valor reducido.\n" +
                    "• Si pasan varios meses sin control, se cobra como primera vez.\n" +
                    "• El pago se realiza el mismo día en el consultorio.\n" +
                    "• No realizamos consultas domiciliarias.\n" +
                    "• No manejamos urgencias.\n\n" +
                    "1️⃣ Agendar consulta\n" +
                    "2️⃣ Hablar con la secretaria\n" +
                    "0️⃣ Volver",
                nextState: "INFO_COSTOS",
                data: {},
            };

        case "3":
            return {
                response:
                    "Las teleconsultas no se realizan diariamente.\n\n" +
                    "Son principalmente para pacientes que ya tuvieron consulta reciente.\n\n" +
                    "¿Ya tuviste consulta reciente con el Dr.?\n\n" +
                    "1️⃣ Sí\n" +
                    "2️⃣ No",
                nextState: "TELECONSULTA",
                data: {},
            };

        case "4":
            return {
                response:
                    "Si presentas:\n\n" +
                    "• Supuración de herida\n" +
                    "• Cambios extraños\n" +
                    "• Dolor intenso\n\n" +
                    "Puedes enviarnos fotos para que el Dr. las revise.\n\n" +
                    "1️⃣ Enviar imágenes\n" +
                    "2️⃣ Agendar cita de control\n" +
                    "3️⃣ Hablar con secretaria",
                nextState: "POST_SURGERY",
                data: {},
            };

        case "5":
            return {
                response:
                    "Te comunicaré con la secretaria 😊\nEn breve te responderá.",
                nextState: "SECRETARIA",
                data: { reason: "MANUAL_REQUEST" },
            };

        default:
            return { response: mainMenu, nextState: "MENU", data };
    }
}
