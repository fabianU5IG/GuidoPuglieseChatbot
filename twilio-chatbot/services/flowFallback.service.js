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
const TEMPLATE_IA_REDIRECCION_SECRETARIA = "HXb3c1b58fd9b398790b07579f054885e5";

function normalizeButtonPayload(value = "") {
    return String(value || "")
        .trim()
        .toLowerCase()
        .normalize("NFD")
        .replace(/[̀-ͯ]/g, "");
}

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
    const buttonPayload = normalizeButtonPayload(message);

    // Respuesta a los botones de la plantilla "ia_redireccion_secretaria"
    // (HXb3c1b58fd9b398790b07579f054885e5). Se resuelve aquí de forma
    // centralizada -y antes que cualquier otra cosa- porque el botón puede
    // llegar estando en cualquier estado (se pregunta sin cambiar de state),
    // y no todos los states/*.state.js reconocen estos payloads por su cuenta.
    if (buttonPayload === "menu_secretaria") {
        try {
            await notifySecretarySupportRequest({
                patientPhone: context.from,
                patientName: data.fullName || data.patientName || "Paciente",
                reason: "El paciente confirmó que quiere hablar con una persona",
                note: "Confirmado desde el botón de la plantilla de redirección de IA.",
            });
            await sendWhatsAppMessage(
                context.from,
                "Tu solicitud fue enviada a la secretaria y te responderemos por este mismo medio.\n\nMientras esperas, puedes seguir usando el menú:",
            );
        } catch (error) {
            console.error(
                "❌ No fue posible notificar a la secretaria (confirmación IA):",
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

    if (buttonPayload === "continuar") {
        return {
            response: "Perfecto, seguimos por aquí 😊",
            nextState: currentState,
            data,
        };
    }

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

        // Si ya está en AGENDAR y la IA cree que "quiere agendar", reiniciar el
        // registro perdería el nombre/documento/etc. que ya escribió. Se deja
        // que el paso actual repita su propio mensaje en vez de retroceder.
        if (decision === "GO_SCHEDULE" && currentState === "AGENDAR") return null;

        if (decision === "TALK_TO_HUMAN") {
            // No se notifica de una vez: se pregunta primero con la plantilla
            // aprobada "ia_redireccion_secretaria" (botones "Sí, comunicarme" /
            // "No, continuar aquí"). La confirmación real se maneja arriba,
            // en el chequeo de `buttonPayload === "menu_secretaria"`.
            return {
                response: null,
                nextState: currentState,
                data,
                sendTemplate: true,
                template: {
                    contentSid: TEMPLATE_IA_REDIRECCION_SECRETARIA,
                    variables: null,
                },
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

            // Cierre alineado al texto ya aprobado por WhatsApp en la plantilla
            // "msj_ia_responde" (HX75b5dbc58a39cc1af5da5e7abc5908e4), para no
            // tener dos redacciones distintas del mismo mensaje.
            return {
                response:
                    `${answer}\n\n` +
                    "😊 Espero que esta información te haya ayudado.\n\n" +
                    "Puedes continuar con tu solicitud o, si prefieres consultar otras opciones, escribe MENÚ para volver al inicio.",
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
