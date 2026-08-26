import {
    notifySecretarySupportRequest,
    sendWhatsAppMessage,
} from "../services/whatsapp.service.js";
import { resolveFlowFallback } from "../services/flowFallback.service.js";

const TEMPLATE_MENU_PRINCIPAL = "HX8a87673651f780a2781725fb23872427";
const TEMPLATE_GESTION_CITA = "HXe1da2f8036073f44fad55c7a72f9e155";
const TEMPLATE_INFO_COSTOS = "HX5256580c02d8a037cbafa7e5a3c1fd55";
const TEMPLATE_TELECONSULTA =
    process.env.TWILIO_TELECONSULTA_TEMPLATE_SID ||
    "HXdcf56e75504920c35e7e46f4f6c6753b";
const TEMPLATE_POSTOP_TIEMPO_CIRUGIA = "HXac4185b56c6a8f99a45e9aabc91b74ff";
const TEMPLATE_AGENDAMIENTO_INICIO = "HX94711af7408f422962cb914731d0bae6";

function sendTemplate(
    contentSid,
    nextState = "MENU",
    data = {},
    variables = null,
) {
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

const MONTH_NUMBER_BY_NAME = {
    enero: 1,
    febrero: 2,
    marzo: 3,
    abril: 4,
    mayo: 5,
    junio: 6,
    julio: 7,
    agosto: 8,
    septiembre: 9,
    setiembre: 9,
    octubre: 10,
    noviembre: 11,
    diciembre: 12,
};

function extractRequestedDateDDMM(normalizedMsg = "") {
    const numericDate = normalizedMsg.match(
        /\b([0-3]?\d)[\/-]([01]?\d)(?:[\/-](\d{4}))?\b/,
    );

    if (numericDate) {
        const day = Number(numericDate[1]);
        const month = Number(numericDate[2]);
        if (day >= 1 && day <= 31 && month >= 1 && month <= 12) {
            return `${String(day).padStart(2, "0")}/${String(month).padStart(2, "0")}`;
        }
    }

    const monthNames = Object.keys(MONTH_NUMBER_BY_NAME).join("|");
    const writtenDate = normalizedMsg.match(
        new RegExp(`\\b([0-3]?\\d)\\s+(?:de\\s+)?(${monthNames})\\b`, "i"),
    );

    if (!writtenDate) return null;

    const day = Number(writtenDate[1]);
    const month = MONTH_NUMBER_BY_NAME[writtenDate[2].toLowerCase()];
    if (!month || day < 1 || day > 31) return null;

    return `${String(day).padStart(2, "0")}/${String(month).padStart(2, "0")}`;
}

function isExpressBookingIntent(normalizedMsg = "") {
    // No debe capturar solicitudes de cancelar/reagendar (esas tienen su
    // propio flujo) aunque el texto también incluya "cita" y alguna palabra
    // de urgencia, ej: "necesito cancelar mi cita ya".
    const isManagementRequest =
        /\b(cancelar|cancela|reagendar|reprogramar|cambiar|mover|eliminar)\b/.test(
            normalizedMsg,
        );
    if (isManagementRequest) return false;

    if (
        /(lo\s+mas\s+pronto\s+(posible|que\s+haya)|cuanto\s+antes|lo\s+antes\s+posible|\burgente\b|primera\s+(cita\s+)?disponible|fecha\s+mas\s+(cercana|pronta|proxima)|\bpara\s+ya\b|\bya\s+mismo\b)/.test(
            normalizedMsg,
        )
    ) {
        return true;
    }

    // Formas informales tipo "ayudaaa necesito una cita para ya" / "necesito
    // cita ya": basta con que aparezcan las tres ideas (necesito + cita + ya)
    // en cualquier orden, sin exigir una frase exacta.
    return (
        /\bnecesito\b/.test(normalizedMsg) &&
        /\b(cita|consulta)\b/.test(normalizedMsg) &&
        /\bya\b/.test(normalizedMsg)
    );
}

function isDirectScheduleRequest(normalizedMsg = "") {
    const hasAppointmentWord =
        /\b(cita|citas|consulta|consultas|agendar|agenda|reservar|separar)\b/.test(
            normalizedMsg,
        );
    const isManagementRequest =
        /\b(cancelar|cancela|reagendar|reprogramar|cambiar|mover|eliminar)\b/.test(
            normalizedMsg,
        );

    return Boolean(
        hasAppointmentWord &&
        !isManagementRequest &&
        extractRequestedDateDDMM(normalizedMsg),
    );
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
        compactMsg === "costos_secretaria" ||
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
        normalizedMsg === "soy paciente postoperatorio" ||
        normalizedMsg === "soy paciente posoperatorio" ||
        normalizedMsg === "postoperatorio" ||
        normalizedMsg === "posoperatorio" ||
        normalizedMsg === "postoperatoria" ||
        normalizedMsg === "posoperatoria" ||
        normalizedMsg === "postoperativo" ||
        compactMsg === "menu_postquirurgico" ||
        compactMsg === "menu_postoperatorio" ||
        compactMsg === "menu_posoperatorio" ||
        compactMsg === "paciente_postoperatorio" ||
        compactMsg === "paciente_posoperatorio" ||
        compactMsg === "post_surgery" ||
        normalizedMsg.includes("postquirurg") ||
        normalizedMsg.includes("postoperator") ||
        normalizedMsg.includes("posoperator") ||
        normalizedMsg.includes("postoperat") ||
        normalizedMsg.includes("despues de cirugia") ||
        normalizedMsg.includes("después de cirugia")
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

    // Se evalúa antes de cualquier solicitud general de cita para evitar que
    // payloads como "agendar cita postoperatoria" entren al flujo equivocado.
    if (isPostSurgeryIntent(normalizedMsg, compactMsg)) {
        return sendTemplate(TEMPLATE_POSTOP_TIEMPO_CIRUGIA, "POST_SURGERY", {
            step: "ASK_POST_SURGERY_DAYS",
        });
    }

    // Permite iniciar una cita directamente desde lenguaje natural en el menú,
    // conservando la fecha indicada para usarla al llegar a la selección de agenda.
    // Ejemplo: "citas para jueves 13 de agosto".
    if (isDirectScheduleRequest(normalizedMsg)) {
        const pendingDateInput = extractRequestedDateDDMM(normalizedMsg);

        return {
            response:
                `Entendido. Guardé tu solicitud de cita para el ${pendingDateInput}.\n\n` +
                "Primero necesito validar tus datos para consultar la disponibilidad real.\n\n" +
                "¿Cuál es tu nombre completo?",
            nextState: "AGENDAR",
            data: {
                step: "ASK_NAME",
                origin: "CONSULTA_GENERAL",
                consultationMode: "PRESENCIAL",
                aiSchedulingEnabled: true,
                pendingDateInput,
                pendingSchedulingRequest: String(msg || "").trim(),
            },
        };
    }

    // "Quiero una cita para lo más pronto posible" / "cita urgente" / etc.:
    // igual que arriba, pero en vez de guardar una fecha literal, se guarda la
    // preferencia tal cual la escribió el paciente. Al llegar a ASK_DATE,
    // agendarState() ya reconoce frases como "lo más pronto posible" o "urgente"
    // (isRecommendationRequest) y las convierte en una solicitud de recomendación
    // de IA — así que el registro se salta la pregunta de fecha por su cuenta,
    // sin necesitar un caso especial aquí.
    if (isExpressBookingIntent(normalizedMsg)) {
        return {
            response:
                "Entendido, vamos a buscarte la cita disponible más pronto posible. 🩺\n\n" +
                "Primero necesito validar tus datos para consultar la disponibilidad real.\n\n" +
                "¿Cuál es tu nombre completo?",
            nextState: "AGENDAR",
            data: {
                step: "ASK_NAME",
                origin: "CONSULTA_GENERAL",
                consultationMode: "PRESENCIAL",
                aiSchedulingEnabled: true,
                pendingDateInput: String(msg || "").trim(),
                pendingSchedulingRequest: String(msg || "").trim(),
                expressBooking: true,
            },
        };
    }

    // Botón / payload del menú principal: gestionar cita.
    if (isManageAppointmentIntent(normalizedMsg, compactMsg)) {
        return sendTemplate(
            TEMPLATE_GESTION_CITA,
            "GESTION_CITAS",
            { rendered: true }
        );
    }

    // Botón "Agendar consulta" desde Información general y costos.
        if (compactMsg === "costos_agendar") {
            return sendTemplate(
                TEMPLATE_GESTION_CITA,
                "GESTION_CITAS",
                { rendered: true }
            );
        }

    // Botón / payload del menú principal: información y costos.
    if (isInfoIntent(normalizedMsg, compactMsg)) {
        return sendTemplate(TEMPLATE_INFO_COSTOS, "INFO_COSTOS", {
            rendered: true,
        });
    }

    // Teleconsulta tiene una plantilla y un flujo independientes.
    if (isTeleconsultaIntent(normalizedMsg, compactMsg)) {
        return sendTemplate(TEMPLATE_TELECONSULTA, "TELECONSULTA", {
            renderTemplate: false,
        });
    }

    // Botón desde plantilla de costos: iniciar directamente agendamiento.
    if (isScheduleIntent(normalizedMsg, compactMsg)) {
        return sendTemplate(TEMPLATE_AGENDAMIENTO_INICIO, "AGENDAR", {
            step: "ASK_NAME",
            origin: "CONSULTA_GENERAL",
            consultationMode: "PRESENCIAL",
            aiSchedulingEnabled: true,
        });
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
            console.error(
                "❌ No fue posible notificar a la secretaria:",
                error,
            );
        }

        try {
            await sendWhatsAppMessage(
                context.from,
                "Tu solicitud fue enviada a la secretaria y te responderemos por este mismo medio.\n\n" +
                    "Mientras esperas, puedes seguir usando el menú:",
            );
        } catch (error) {
            console.error("❌ No fue posible enviar el aviso de solicitud enviada:", error);
        }

        return sendTemplate(TEMPLATE_MENU_PRINCIPAL, "MENU", {});
    }

    const aiFallback = await resolveFlowFallback({
        message: msg,
        currentState: "MENU",
        currentStep: null,
        data,
        context,
    });
    if (aiFallback) return aiFallback;

    return sendTemplate(TEMPLATE_MENU_PRINCIPAL, "MENU", {});
}
