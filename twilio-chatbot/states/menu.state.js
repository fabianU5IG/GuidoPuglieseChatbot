const TEMPLATE_MENU_PRINCIPAL = "HXa378d250620cf7abd92cbb65e341801d";
const TEMPLATE_GESTION_CITA = "HX4148f8bb8a8e0312b0f58302b1cd48d7";
const TEMPLATE_INFO_COSTOS = "HXbefe23f2c63f385dd20bf6c2d4d0d714";

function sendTemplate(contentSid, nextState = "MENU", data = {}) {
    return {
        response: null,
        nextState,
        data,
        sendTemplate: true,
        template: {
            contentSid,
            variables: null,
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
        .replace(/[_-]+/g, " ")
        .replace(/\s+/g, " ")
        .trim();
}

export default function menuState(msg, data = {}) {
    const mainMenu =
        "Hola 👋\n\n" +
        "Soy el asistente del consultorio del Dr. Guido Pugliese, Ortopedista – Traumatólogo.\n\n" +
        "¿En qué puedo ayudarte hoy?\n\n" +
        "1️⃣ Agendar o gestionar mi cita\n" +
        "2️⃣ Información general y costos\n" +
        "3️⃣ Teleconsulta (lectura de estudios)\n" +
        "4️⃣ Soy paciente postquirúrgico\n" +
        "5️⃣ Hablar con la secretaria";

    const normalizedMsg = normalizeOption(msg);

    if (normalizedMsg === "hola" ||
        normalizedMsg === "hello" ||
        normalizedMsg === "menu" ||
        normalizedMsg.includes("volver") ||
        normalizedMsg.includes("menu principal")) {
        return sendTemplate(TEMPLATE_MENU_PRINCIPAL, "MENU", {});
    }

    if (data?.renderMenu) {
        return sendTemplate(TEMPLATE_MENU_PRINCIPAL, "MENU", {});
    }

    // Botón / texto de menú principal: gestionar cita
    if (
        normalizedMsg === "1" ||
        normalizedMsg.includes("gestionar cita") ||
        normalizedMsg.includes("gestion cita") ||
        normalizedMsg.includes("gestionar mi cita") ||
        normalizedMsg.includes("agendar o gestionar") ||
        normalizedMsg.includes("agendar cita") ||
        normalizedMsg.includes("menu gestionar cita") ||
        normalizedMsg.includes("gestion citas")
    ) {
        return sendTemplate(TEMPLATE_GESTION_CITA, "GESTION_CITAS", { rendered: true });
    }

    // Botón / texto de menú principal: información y costos
    if (
        normalizedMsg === "2" ||
        normalizedMsg.includes("informacion") ||
        normalizedMsg.includes("costos") ||
        normalizedMsg.includes("precio") ||
        normalizedMsg.includes("valor")
    ) {
        return sendTemplate(TEMPLATE_INFO_COSTOS, "INFO_COSTOS", { rendered: true });
    }

    switch (normalizedMsg) {
        case "3":
        case "teleconsulta":
        case "lectura de estudios":
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
        case "soy paciente postquirurgico":
        case "postquirurgico":
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
        case "hablar con la secretaria":
        case "secretaria":
            return {
                response: "Te comunicaré con la secretaria 😊\nEn breve te responderá.",
                nextState: "SECRETARIA",
                data: { reason: "MANUAL_REQUEST" },
            };

        default:
            return { response: mainMenu, nextState: "MENU", data: {} };
    }
}
