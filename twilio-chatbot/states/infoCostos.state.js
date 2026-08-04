const TEMPLATE_MENU_PRINCIPAL = "HXa378d250620cf7abd92cbb65e341801d";
const TEMPLATE_INFO_COSTOS = "HXbefe23f2c63f385dd20bf6c2d4d0d714";
const SECRETARY_WHATSAPP_NUMBER = process.env.SECRETARY_WHATSAPP_NUMBER || "+573224811542";

function buildSecretaryWhatsappLink() {
    const digits = String(SECRETARY_WHATSAPP_NUMBER || "").replace(/\D/g, "");
    return `https://wa.me/${digits}`;
}

function sendTemplate(contentSid, nextState = "MENU", data = {}, variables = null) {
    return {
        response: null,
        nextState,
        data,
        sendTemplate: true,
        template: {
            contentSid,
            variables,
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
        .replace(/[._-]+/g, " ")
        .replace(/\s+/g, " ")
        .trim();
}

function compact(value = "") {
    return normalizeOption(value).replace(/\s+/g, "_");
}

function isBackIntent(normalizedMsg, compactMsg) {
    return (
        normalizedMsg === "0" ||
        normalizedMsg === "menu" ||
        normalizedMsg === "inicio" ||
        compactMsg === "volver_menu" ||
        compactMsg === "menu_principal" ||
        compactMsg === "volver_al_menu" ||
        normalizedMsg.includes("volver") ||
        normalizedMsg.includes("menu principal")
    );
}

function isScheduleIntent(normalizedMsg, compactMsg) {
    return (
        normalizedMsg === "1" ||
        normalizedMsg === "agendar" ||
        normalizedMsg === "agendar cita" ||
        normalizedMsg === "agendar consulta" ||
        normalizedMsg === "agenda consulta" ||
        compactMsg === "agendar" ||
        compactMsg === "agendar_cita" ||
        compactMsg === "agendar_consulta" ||
        compactMsg === "agendar_nueva_consulta" ||
        compactMsg === "nueva_consulta" ||
        compactMsg === "btn_agendar_consulta" ||
        compactMsg === "teleconsulta_agendar" ||
        normalizedMsg.includes("agendar consulta") ||
        normalizedMsg.includes("agendar cita") ||
        normalizedMsg.includes("nueva consulta") ||
        normalizedMsg.includes("quiero agendar")
    );
}

function isInfoIntent(normalizedMsg, compactMsg) {
    return (
        normalizedMsg === "2" ||
        compactMsg === "menu_info" ||
        compactMsg === "info_costos" ||
        compactMsg === "informacion_costos" ||
        compactMsg === "informacion_general" ||
        compactMsg === "info_general" ||
        compactMsg === "btn_informacion_general" ||
        normalizedMsg.includes("informacion") ||
        normalizedMsg.includes("costos") ||
        normalizedMsg.includes("precio") ||
        normalizedMsg.includes("valor")
    );
}

function isPostSurgeryIntent(normalizedMsg, compactMsg) {
    return (
        normalizedMsg === "3" ||
        normalizedMsg === "4" ||
        normalizedMsg === "postoperatorio" ||
        normalizedMsg === "post operatorio" ||
        normalizedMsg === "postoperatoria" ||
        normalizedMsg === "post quirurgico" ||
        normalizedMsg === "postquirurgico" ||
        compactMsg === "postoperatorio" ||
        compactMsg === "post_operatorio" ||
        compactMsg === "menu_postoperatorio" ||
        compactMsg === "menu_postquirurgico" ||
        compactMsg === "post_surgery" ||
        compactMsg === "post_cirugia" ||
        normalizedMsg.includes("postoperator") ||
        normalizedMsg.includes("post quirurg") ||
        normalizedMsg.includes("postquirurg") ||
        normalizedMsg.includes("post cirugia")
    );
}

function isSecretaryIntent(normalizedMsg, compactMsg) {
    return (
        normalizedMsg === "5" ||
        normalizedMsg === "secretaria" ||
        normalizedMsg === "hablar con secretaria" ||
        compactMsg === "menu_secretaria" ||
        compactMsg === "hablar_secretaria" ||
        compactMsg === "hablar_con_secretaria" ||
        normalizedMsg.includes("secretaria") ||
        normalizedMsg.includes("asesor")
    );
}

function buildPostSurgeryMenu() {
    return (
        "Para orientarte correctamente, indícanos cuánto tiempo ha pasado desde la cirugía:\n\n" +
        "1️⃣ Han pasado 15 días o más: agendar cita posoperatoria\n" +
        "2️⃣ Han pasado menos de 15 días: enviar imágenes para revisión\n" +
        "3️⃣ Hablar con la secretaria\n" +
        "0️⃣ Volver al menú"
    );
}

function buildTeleconsultaMenu() {
    return (
        "🩺 Teleconsulta / lectura de estudios\n\n" +
        "Este canal te permite iniciar una consulta para revisión de estudios o recibir orientación sobre el proceso.\n\n" +
        "Selecciona una opción:\n\n" +
        "1️⃣ Agendar consulta\n" +
        "2️⃣ Información general\n" +
        "3️⃣ Postoperatorio\n" +
        "0️⃣ Volver al menú"
    );
}

export default function infoCostosState(msg, data = {}) {
    const normalizedMsg = normalizeOption(msg);
    const compactMsg = compact(msg);
    const origin = data?.origin || "INFO_COSTOS";

    if (!normalizedMsg) {
        if (origin === "TELECONSULTA") {
            return {
                response: buildTeleconsultaMenu(),
                nextState: "TELECONSULTA",
                data: { origin: "TELECONSULTA" },
            };
        }

        return sendTemplate(TEMPLATE_INFO_COSTOS, "INFO_COSTOS", {
            origin: "INFO_COSTOS",
        });
    }

    if (isBackIntent(normalizedMsg, compactMsg)) {
        return sendTemplate(TEMPLATE_MENU_PRINCIPAL, "MENU", {});
    }

    // Importante: agendar se evalúa antes de información para evitar que
    // botones como "Agendar consulta" caigan de nuevo en la plantilla de costos.
    if (isScheduleIntent(normalizedMsg, compactMsg)) {
        return {
            response:
                "Vamos a iniciar el agendamiento.\n\n" +
                "La IA podrá recomendarte opciones disponibles según la fecha y el horario que prefieras.\n\n" +
                "¿Cuál es tu nombre completo?",
            nextState: "AGENDAR",
            data: {
                step: "ASK_NAME",
                origin: "CONSULTA_GENERAL",
                consultationMode: "PRESENCIAL",
                aiSchedulingEnabled: true,
            },
        };
    }

    if (isPostSurgeryIntent(normalizedMsg, compactMsg)) {
        return {
            response: buildPostSurgeryMenu(),
            nextState: "POST_SURGERY",
            data: {},
        };
    }

    if (isSecretaryIntent(normalizedMsg, compactMsg)) {
        return {
            response:
                "Puedes comunicarte directamente con la secretaria en este enlace:\n" +
                buildSecretaryWhatsappLink(),
            nextState: origin === "TELECONSULTA" ? "TELECONSULTA" : "INFO_COSTOS",
            data: { origin },
        };
    }

    if (isInfoIntent(normalizedMsg, compactMsg)) {
        return sendTemplate(TEMPLATE_INFO_COSTOS, "INFO_COSTOS", {
            origin: "INFO_COSTOS",
        });
    }

    if (origin === "TELECONSULTA") {
        return {
            response: buildTeleconsultaMenu(),
            nextState: "TELECONSULTA",
            data: { origin: "TELECONSULTA" },
        };
    }

    return sendTemplate(TEMPLATE_INFO_COSTOS, "INFO_COSTOS", {
        origin: "INFO_COSTOS",
    });
}
