import { resolveFlowFallback } from "../services/flowFallback.service.js";

const TEMPLATE_MENU_PRINCIPAL = "HX58b32a7d0047f3359d9680ecf201c250";
// Debe coincidir con la plantilla que envía menu.state.js para "Información y costos".
const TEMPLATE_INFO_COSTOS = "HXb039d2b0b02ef16a1b381d9319adf433";
const TEMPLATE_POSTOP_TIEMPO_CIRUGIA = "HX6c1722022a73ccc66a147b3be033fa2d";
const TEMPLATE_TELECONSULTA_DESDE_COSTOS = "HX232d7e27f762934d6456e700a79f1ea9";
const TEMPLATE_AGENDAMIENTO_INICIO = "HXb4e3cc876818f3affb9035fb0bd13c17";
const SECRETARY_WHATSAPP_NUMBER = process.env.SECRETARY_WHATSAPP_NUMBER || "+573203269984";

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
        // Botón "Volver" real de la plantilla de info/costos (HX5256580c...);
        // su id es "costos_volver", no "volver" a secas.
        compactMsg === "costos_volver" ||
        normalizedMsg === "volver" ||
        normalizedMsg.includes("volver al menu") ||
        normalizedMsg.includes("volver menu") ||
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
        compactMsg === "costos_agendar" ||
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

function isTeleconsultaIntent(normalizedMsg, compactMsg) {
    return (
        normalizedMsg === "teleconsulta" ||
        compactMsg === "menu_teleconsulta" ||
        compactMsg === "lectura_estudios" ||
        normalizedMsg.includes("teleconsulta") ||
        normalizedMsg.includes("lectura de estudios")
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

export default async function infoCostosState(msg, data = {}, context = {}) {
    const normalizedMsg = normalizeOption(msg);
    const compactMsg = compact(msg);
    const origin = data?.origin || "INFO_COSTOS";

    if (!normalizedMsg) {
        if (origin === "TELECONSULTA") {
            return sendTemplate(TEMPLATE_TELECONSULTA_DESDE_COSTOS, "TELECONSULTA", {
                origin: "TELECONSULTA",
            });
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
        return sendTemplate(TEMPLATE_AGENDAMIENTO_INICIO, "AGENDAR", {
            step: "ASK_NAME",
            origin: "CONSULTA_GENERAL",
            consultationMode: "PRESENCIAL",
            aiSchedulingEnabled: true,
        });
    }

    if (isPostSurgeryIntent(normalizedMsg, compactMsg)) {
        return sendTemplate(TEMPLATE_POSTOP_TIEMPO_CIRUGIA, "POST_SURGERY", {
            step: "ASK_POST_SURGERY_DAYS",
        });
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

    if (isTeleconsultaIntent(normalizedMsg, compactMsg)) {
        return sendTemplate(TEMPLATE_TELECONSULTA_DESDE_COSTOS, "TELECONSULTA", {
            origin: "TELECONSULTA",
        });
    }

    if (isInfoIntent(normalizedMsg, compactMsg)) {
        return sendTemplate(TEMPLATE_INFO_COSTOS, "INFO_COSTOS", {
            origin: "INFO_COSTOS",
        });
    }

    const aiFallback = await resolveFlowFallback({
        message: msg,
        currentState: "INFO_COSTOS",
        currentStep: null,
        data,
        context,
    });
    if (aiFallback) return aiFallback;

    if (origin === "TELECONSULTA") {
        return sendTemplate(TEMPLATE_TELECONSULTA_DESDE_COSTOS, "TELECONSULTA", {
            origin: "TELECONSULTA",
        });
    }

    return sendTemplate(TEMPLATE_INFO_COSTOS, "INFO_COSTOS", {
        origin: "INFO_COSTOS",
    });
}
