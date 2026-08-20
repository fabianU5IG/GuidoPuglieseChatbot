import { notifySecretarySupportRequest } from "../services/whatsapp.service.js";

const TEMPLATE_MENU_PRINCIPAL = "HXa378d250620cf7abd92cbb65e341801d";
const TEMPLATE_TELECONSULTA =
    process.env.TWILIO_TELECONSULTA_TEMPLATE_SID ||
    "HX18e7c4eb9b23f2fbb53b37f1c2520bed";
const TEMPLATE_TELECONSULTA_REQUISITOS = "HXc09271c38baeaa3ba666f67352280bcc";
const TEMPLATE_TELECONSULTA_INFO_GENERAL = "HX3d6f8d50fc9cbb42d1daf4874de00520";

function sendTemplate(contentSid, nextState = "TELECONSULTA", data = {}, variables = null) {
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
        compactMsg === "teleconsulta_volver_menu" ||
        compactMsg === "teleconsulta_no" ||
        normalizedMsg.includes("volver al menu")
    );
}

function isScheduleIntent(normalizedMsg, compactMsg) {
    return (
        normalizedMsg === "1" ||
        normalizedMsg === "agendar" ||
        normalizedMsg === "agendar teleconsulta" ||
        normalizedMsg === "agendar consulta" ||
        compactMsg === "teleconsulta_agendar" ||
        compactMsg === "agendar_teleconsulta" ||
        compactMsg === "tele_agendar" ||
        compactMsg === "btn_teleconsulta_agendar" ||
        compactMsg === "teleconsulta_si" ||
        normalizedMsg.includes("agendar teleconsulta")
    );
}

function isRequirementsIntent(normalizedMsg, compactMsg) {
    return (
        normalizedMsg === "2" ||
        compactMsg === "teleconsulta_requisitos" ||
        compactMsg === "requisitos_teleconsulta" ||
        compactMsg === "teleconsulta_preparacion" ||
        normalizedMsg.includes("requisito") ||
        normalizedMsg.includes("preparar") ||
        normalizedMsg.includes("que necesito")
    );
}

function isInfoIntent(normalizedMsg, compactMsg) {
    return (
        normalizedMsg === "3" ||
        normalizedMsg === "informacion" ||
        normalizedMsg === "mas informacion" ||
        compactMsg === "teleconsulta_info" ||
        compactMsg === "teleconsulta_informacion" ||
        compactMsg === "como_funciona_teleconsulta" ||
        normalizedMsg.includes("como funciona") ||
        normalizedMsg.includes("informacion teleconsulta")
    );
}

function isSecretaryIntent(normalizedMsg, compactMsg) {
    return (
        normalizedMsg === "4" ||
        normalizedMsg === "secretaria" ||
        normalizedMsg === "asesor" ||
        compactMsg === "teleconsulta_secretaria" ||
        compactMsg === "hablar_secretaria" ||
        compactMsg === "hablar_con_secretaria" ||
        normalizedMsg.includes("secretaria") ||
        normalizedMsg.includes("asesor")
    );
}

export default async function teleconsultaState(msg, data = {}, context = {}) {
    const normalizedMsg = normalizeOption(msg);
    const compactMsg = compact(msg);

    if (!normalizedMsg || data?.renderTemplate) {
        return sendTemplate(TEMPLATE_TELECONSULTA, "TELECONSULTA", {});
    }

    if (isBackIntent(normalizedMsg, compactMsg)) {
        return sendTemplate(TEMPLATE_MENU_PRINCIPAL, "MENU", {});
    }

   if (isScheduleIntent(normalizedMsg, compactMsg)) {
        try {
            await notifySecretarySupportRequest({
                patientPhone: context.from,
                patientName: data.fullName || data.patientName || "Paciente",
                reason: "Solicitud de agendamiento de teleconsulta",
                note:
                    "El paciente solicita agendar una teleconsulta / lectura de estudios.",
            });
        } catch (error) {
            console.error(
                "❌ No fue posible notificar a la secretaria por teleconsulta:",
                error,
            );
        }

        return {
            response:
                "Gracias. Hemos recibido tu solicitud para agendar una teleconsulta.\n\n" +
                "La secretaria revisará la disponibilidad y se comunicará contigo por este mismo medio para continuar con el proceso.",
            nextState: "MENU",
            data: { renderMenu: true },
        };
    }

    if (isRequirementsIntent(normalizedMsg, compactMsg)) {
        return sendTemplate(TEMPLATE_TELECONSULTA_REQUISITOS, "TELECONSULTA", {});
    }

    if (isInfoIntent(normalizedMsg, compactMsg)) {
        return sendTemplate(TEMPLATE_TELECONSULTA_INFO_GENERAL, "TELECONSULTA", {});
    }

    if (isSecretaryIntent(normalizedMsg, compactMsg)) {
        try {
            await notifySecretarySupportRequest({
                patientPhone: context.from,
                patientName: data.fullName || data.patientName || "Paciente",
                reason: "Solicitud relacionada con teleconsulta",
                note: String(context.rawBody?.Body || msg || "").trim(),
            });
        } catch (error) {
            console.error(
                "❌ No fue posible notificar a la secretaria por teleconsulta:",
                error,
            );
        }

        return {
            response:
                "Tu solicitud de teleconsulta fue enviada a la secretaria y te responderemos por este mismo medio.\n\n" +
                "Puedes escribir MENU para volver al inicio.",
            nextState: "TELECONSULTA",
            data: {},
        };
    }

    return sendTemplate(TEMPLATE_TELECONSULTA, "TELECONSULTA", {});
}
