import { askAI, classifyFlowIntentAI } from "./azure.ai.services.js";
import {
    notifySecretarySupportRequest,
    sendWhatsAppMessage,
} from "./whatsapp.service.js";

// Duplicados a propósito: cada states/*.state.js ya repite estos mismos
// contentSid en vez de importarlos de un módulo compartido. Se sigue el mismo
// patrón aquí en vez de convertir menu.state.js en una fuente compartida.
const TEMPLATE_MENU_PRINCIPAL = "HX8a87673651f780a2781725fb23872427";
const TEMPLATE_GESTION_CITA = "HXe1da2f8036073f44fad55c7a72f9e155";
const TEMPLATE_INFO_COSTOS = "HX5256580c02d8a037cbafa7e5a3c1fd55";
const TEMPLATE_TELECONSULTA =
    process.env.TWILIO_TELECONSULTA_TEMPLATE_SID ||
    "HXdcf56e75504920c35e7e46f4f6c6753b";
const TEMPLATE_POSTOP_TIEMPO_CIRUGIA = "HXac4185b56c6a8f99a45e9aabc91b74ff";
const TEMPLATE_AGENDAMIENTO_INICIO = "HX94711af7408f422962cb914731d0bae6";

const AI_NAV_FALLBACK_ENABLED = !["false", "0", "off", "no"].includes(
    String(process.env.AI_NAV_FALLBACK_ENABLED || "true").toLowerCase(),
);
const MIN_CONFIDENCE = Number(process.env.AI_NAV_FALLBACK_MIN_CONFIDENCE || 0.7);

function destinationFor(intent) {
    switch (intent) {
        case "GO_MENU":
            return {
                response: null,
                nextState: "MENU",
                data: {},
                sendTemplate: true,
                template: { contentSid: TEMPLATE_MENU_PRINCIPAL, variables: null },
            };
        case "GO_SCHEDULE":
            return {
                response: null,
                nextState: "AGENDAR",
                data: {
                    step: "ASK_NAME",
                    origin: "CONSULTA_GENERAL",
                    consultationMode: "PRESENCIAL",
                    aiSchedulingEnabled: true,
                },
                sendTemplate: true,
                template: { contentSid: TEMPLATE_AGENDAMIENTO_INICIO, variables: null },
            };
        case "GO_MANAGE_APPOINTMENT":
            return {
                response: null,
                nextState: "GESTION_CITAS",
                data: { rendered: true },
                sendTemplate: true,
                template: { contentSid: TEMPLATE_GESTION_CITA, variables: null },
            };
        case "GO_INFO_COSTOS":
            return {
                response: null,
                nextState: "INFO_COSTOS",
                data: { origin: "INFO_COSTOS" },
                sendTemplate: true,
                template: { contentSid: TEMPLATE_INFO_COSTOS, variables: null },
            };
        case "GO_TELECONSULTA":
            return {
                response: null,
                nextState: "TELECONSULTA",
                data: {},
                sendTemplate: true,
                template: { contentSid: TEMPLATE_TELECONSULTA, variables: null },
            };
        case "GO_POST_SURGERY":
            return {
                response: null,
                nextState: "POST_SURGERY",
                data: { step: "ASK_POST_SURGERY_DAYS" },
                sendTemplate: true,
                template: {
                    contentSid: TEMPLATE_POSTOP_TIEMPO_CIRUGIA,
                    variables: null,
                },
            };
        default:
            return null;
    }
}

/**
 * Único punto de entrada de IA para "no reconocí este mensaje" en todo el bot.
 * Contrato: NUNCA lanza (try/catch total) y devuelve `null` cuando no debe
 * cambiar nada, para que el llamador simplemente ejecute su fallback actual
 * sin modificaciones. Nunca degrada por debajo del comportamiento de hoy.
 */
export async function resolveFlowFallback({
    message,
    currentState,
    currentStep = null,
    data = {},
    context = {},
}) {
    if (!AI_NAV_FALLBACK_ENABLED) return null;

    try {
        const result = await classifyFlowIntentAI({
            message,
            currentState,
            currentStep,
        });

        const decision = !result
            ? "NO_AI"
            : result.confidence < MIN_CONFIDENCE || result.intent === "UNKNOWN"
              ? "LOW_CONFIDENCE"
              : result.intent;

        console.log("🧭 IA fallback navegación:", {
            phone: context?.from,
            currentState,
            currentStep,
            message,
            intent: result?.intent || null,
            confidence: result?.confidence ?? null,
            decision,
        });

        if (decision === "NO_AI" || decision === "LOW_CONFIDENCE") return null;

        if (decision === "TALK_TO_HUMAN") {
            try {
                await notifySecretarySupportRequest({
                    patientPhone: context.from,
                    patientName: data.fullName || data.patientName || "Paciente",
                    reason:
                        "Solicitud detectada por IA: el paciente quiere hablar con una persona",
                    note: message,
                });
                await sendWhatsAppMessage(
                    context.from,
                    "Tu solicitud fue enviada a la secretaria y te responderemos por este mismo medio.\n\nMientras esperas, puedes seguir usando el menú:",
                );
            } catch (error) {
                console.error(
                    "❌ No fue posible notificar a la secretaria (fallback IA):",
                    error,
                );
            }

            return {
                response: null,
                nextState: "MENU",
                data: {},
                sendTemplate: true,
                template: { contentSid: TEMPLATE_MENU_PRINCIPAL, variables: null },
            };
        }

        if (decision === "OPEN_QUESTION") {
            // Si ya conocemos su nombre (por esta u otra operación en la misma
            // sesión, vía la memoria de Fabian), se lo hacemos saber a la IA
            // para que no le hable como a un desconocido.
            const knownFirstName =
                data.firstName ||
                (data.fullName ? String(data.fullName).split(/\s+/)[0] : null);

            const answer = await askAI(
                message,
                `\nEl paciente está en la sección "${currentState}" del chatbot.` +
                    (knownFirstName
                        ? ` Ya sabes que se llama ${knownFirstName} (dato de esta sesión); puedes dirigirte a él/ella por su nombre si es natural, y no le pidas que se identifique de nuevo.`
                        : "") +
                    ' Si su pregunta requiere agendar una cita, gestionar una cita existente o hablar con la secretaria, indícale brevemente cómo continuar (ej: escribir "agendar" o "0" para volver al menú), pero no inventes botones ni pasos que no existen.',
            );

            return {
                response: `${answer}\n\nPuedes continuar donde ibas o escribir *menu* para volver al inicio.`,
                nextState: currentState,
                data,
            };
        }

        return destinationFor(decision) || null;
    } catch (error) {
        console.error("❌ resolveFlowFallback error inesperado:", error);
        return null;
    }
}
