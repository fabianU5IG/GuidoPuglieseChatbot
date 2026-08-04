import { notifySecretarySupportRequest } from "../services/whatsapp.service.js";

const TEMPLATE_MENU_PRINCIPAL = "HXa378d250620cf7abd92cbb65e341801d";
const TEMPLATE_GESTION_CITA = "HX4148f8bb8a8e0312b0f58302b1cd48d7";
const TEMPLATE_INFO_COSTOS = "HXf5c183219cbd50ed9a261edc7f4f16f3";
const TEMPLATE_TELECONSULTA =
    process.env.TWILIO_TELECONSULTA_TEMPLATE_SID ||
    "HX18e7c4eb9b23f2fbb53b37f1c2520bed";
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

function isScheduleIntent(normalizedMsg, compactMsg) {
    return (
        normalizedMsg === "agendar" ||
        normalizedMsg === "agendar cita" ||
        normalizedMsg === "agenda cita" ||
        normalizedMsg === "boton agendar cita" ||
        compactMsg === "agendar_cita" ||
        compactMsg === "nueva_cita" ||
        compactMsg === "agendar_nueva_consulta" ||
        normalizedMsg.includes("agendar cita") ||
        normalizedMsg.includes("agendar una cita") ||
        normalizedMsg.includes("quiero agendar")
    );
}

function isAdvisorIntent(normalizedMsg, compactMsg) {
    return (
        normalizedMsg === "5" ||
        normalizedMsg === "asesor" ||
        normalizedMsg === "hablar asesor" ||
        normalizedMsg === "hablar con asesor" ||
        normalizedMsg === "hablar con un asesor" ||
        normalizedMsg === "secretaria" ||
        normalizedMsg === "hablar con secretaria" ||
        normalizedMsg === "hablar con la secretaria" ||
        compactMsg === "menu_secretaria" ||
        compactMsg === "hablar_secretaria" ||
        compactMsg === "hablar_con_secretaria" ||
        normalizedMsg.includes("asesor") ||
        normalizedMsg.includes("secretaria")
    );
}

function isTeleconsultaIntent(normalizedMsg, compactMsg) {
    return (
        normalizedMsg === "3" ||
        normalizedMsg === "teleconsulta" ||
        compactMsg === "menu_teleconsulta" ||
        compactMsg === "lectura_estudios" ||
        normalizedMsg.includes("teleconsulta") ||
        normalizedMsg.includes("lectura de estudios")
    );
}

function isPostSurgeryIntent(normalizedMsg, compactMsg) {
    return (
        normalizedMsg === "4" ||
        normalizedMsg === "soy paciente postquirurgico" ||
        normalizedMsg === "postquirurgico" ||
        compactMsg === "menu_postquirurgico" ||
        compactMsg === "post_surgery" ||
        normalizedMsg.includes("postquirurg")
    );
}

function isManageAppointmentIntent(normalizedMsg, compactMsg) {
    return (
        normalizedMsg === "1" ||
        compactMsg === "menu_cita" ||
        compactMsg === "menu_gestion_cita" ||
        compactMsg === "gestionar_cita" ||
        compactMsg === "gestionar_mi_cita" ||
        compactMsg === "agendar_gestionar_cita" ||
        normalizedMsg.includes("gestionar cita") ||
        normalizedMsg.includes("gestion cita") ||
        normalizedMsg.includes("gestionar mi cita") ||
        normalizedMsg.includes("agendar o gestionar") ||
        normalizedMsg.includes("gestion citas")
    );
}

function isInfoIntent(normalizedMsg, compactMsg) {
    return (
        normalizedMsg === "2" ||
        compactMsg === "menu_info" ||
        compactMsg === "info_costos" ||
        compactMsg === "informacion_costos" ||
        compactMsg === "informacion_general" ||
        normalizedMsg.includes("informacion") ||
        normalizedMsg.includes("costos") ||
        normalizedMsg.includes("precio") ||
        normalizedMsg.includes("valor")
    );
}

export default async function menuState(msg, data = {}, context = {}) {
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
    const compactMsg = compact(msg);

    if (data?.renderMenu) {
        return sendTemplate(TEMPLATE_MENU_PRINCIPAL, "MENU", {});
    }

    if (
        normalizedMsg === "hola" ||
        normalizedMsg === "hello" ||
        normalizedMsg === "menu" ||
        normalizedMsg === "inicio" ||
        compactMsg === "volver_menu" ||
        compactMsg === "menu_principal" ||
        normalizedMsg.includes("volver") ||
        normalizedMsg.includes("menu principal")
    ) {
        return sendTemplate(TEMPLATE_MENU_PRINCIPAL, "MENU", {});
    }

    // Botón / payload del menú principal: gestionar cita.
    if (isManageAppointmentIntent(normalizedMsg, compactMsg)) {
        return sendTemplate(TEMPLATE_GESTION_CITA, "GESTION_CITAS", { rendered: true });
    }

    // Botón / payload del menú principal: información y costos.
    if (isInfoIntent(normalizedMsg, compactMsg)) {
        return sendTemplate(TEMPLATE_INFO_COSTOS, "INFO_COSTOS", { rendered: true });
    }

    // Teleconsulta tiene una plantilla y un flujo independientes.
    if (isTeleconsultaIntent(normalizedMsg, compactMsg)) {
        return sendTemplate(TEMPLATE_TELECONSULTA, "TELECONSULTA", {
            renderTemplate: false,
        });
    }

    // Botón desde plantilla de costos: iniciar directamente agendamiento.
    if (isScheduleIntent(normalizedMsg, compactMsg)) {
        return {
            response:
                "Vamos a iniciar el agendamiento.\n\n" +
                "Durante el proceso podrás pedirle a la IA opciones como ‘lo más pronto posible’ o ‘la próxima semana en la tarde’.\n\n" +
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

    if (isAdvisorIntent(normalizedMsg, compactMsg)) {
        try {
            await notifySecretarySupportRequest({
                patientPhone: context.from,
                patientName: data.fullName || data.patientName || "Paciente",
                reason: "Solicitud general a secretaria",
                note: String(context.rawBody?.Body || "").trim(),
            });
        } catch (error) {
            console.error("❌ No fue posible notificar a la secretaria:", error);
        }

        return {
            response:
                "Tu solicitud fue enviada a la secretaria y te responderemos por este mismo medio.\n\n" +
                "Mientras esperas, puedes seguir usando el menú:\n\n" +
                "1️⃣ Agendar o gestionar mi cita\n" +
                "2️⃣ Información general y costos\n" +
                "3️⃣ Teleconsulta (lectura de estudios)\n" +
                "4️⃣ Soy paciente postquirúrgico\n" +
                "5️⃣ Hablar con la secretaria",
            nextState: "MENU",
            data: {},
        };
    }

    if (isPostSurgeryIntent(normalizedMsg, compactMsg)) {
        return {
            response:
                "Para orientarte correctamente, indícanos cuánto tiempo ha pasado desde la cirugía:\n\n" +
                "1️⃣ Han pasado 15 días o más: agendar cita posoperatoria\n" +
                "2️⃣ Han pasado menos de 15 días: enviar imágenes para revisión\n" +
                "3️⃣ Hablar con la secretaria\n" +
                "0️⃣ Volver al menú",
            nextState: "POST_SURGERY",
            data: { step: "ASK_POST_SURGERY_DAYS" },
        };
    }

    return { response: mainMenu, nextState: "MENU", data: {} };
}
