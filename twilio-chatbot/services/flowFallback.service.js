import { askAI, classifyFlowIntentAI } from "./azure.ai.services.js";
import {
    notifySecretarySupportRequest,
    sendWhatsAppMessage,
} from "./whatsapp.service.js";
import { db } from "../db/mysql.js";

// Antes, si el paciente preguntaba algo como "¿sigue intentando mi cita?"
// mientras esperaba, la IA respondía con una reafirmación genérica ("tiene
// una solicitud en curso") sin mirar el estado real en la base de datos —
// podía sonar tranquilizadora sin de verdad saber si ya se había confirmado,
// seguía en proceso, o había fallado. Se consulta el estado real (misma
// tabla que revisa el botón "1" de POST_CREATED en agendar.state.js) para
// que la respuesta esté fundamentada en el dato real, no en una suposición.
async function getRealAppointmentStatus(appointmentId) {
    if (!appointmentId) return null;

    try {
        const [rows] = await db.query(
            "SELECT status FROM appointments WHERE id = ? LIMIT 1",
            [appointmentId],
        );
        return rows?.[0]?.status || null;
    } catch {
        return null;
    }
}

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

        // Desde TELECONSULTA, "agendar" no es un agendamiento presencial
        // normal: antes, una frase natural que no calzara exacto con las
        // palabras clave del propio estado (ej: "sí quiero agendar la
        // teleconsulta") caía aquí y abría el flujo de AGENDAR presencial. Las
        // teleconsultas las coordina la secretaria directamente, igual que ya
        // hace teleconsulta.state.js con su propio botón/keyword de agendar.
        if (decision === "GO_SCHEDULE" && currentState === "TELECONSULTA") {
            try {
                await notifySecretarySupportRequest({
                    patientPhone: context.from,
                    patientName: data.fullName || data.patientName || "Paciente",
                    reason: "Solicitud de agendamiento de teleconsulta",
                    note: `El paciente solicita agendar una teleconsulta / lectura de estudios: "${message}"`,
                });
            } catch (error) {
                console.error(
                    "❌ No fue posible notificar a la secretaria por teleconsulta (IA):",
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

        // "Mejor cambio la fecha" a mitad de un agendamiento: NO es un
        // GO_MENU/GO_SCHEDULE (eso reiniciaría o borraría el registro). Se
        // conserva todo lo ya dado (nombre, documento, etc.) y solo se vuelve
        // a preguntar la fecha.
        //
        // Pero esto solo tiene sentido cuando el registro YA terminó y está
        // eligiendo fecha/hora. Antes solo se comprobaba currentState==="AGENDAR"
        // sin mirar el paso: si la IA malinterpretaba como CHANGE_DATE algo
        // dicho a mitad del registro (ej: "el próximo lunes" dado como
        // segundo nombre, al ser rechazado por el paso, caía aquí), saltaba
        // directo a ASK_DATE botando en silencio apellidos/fecha de
        // nacimiento/EPS/habeas data que todavía no se habían pedido.
        const AGENDAR_REGISTRATION_STEPS = new Set([
            "ASK_NAME",
            "ASK_DOC_TYPE",
            "ASK_DOC_NUMBER",
            "REG_CONFIRM_NAMES",
            "REG_FIRSTNAME",
            "REG_SECONDNAME",
            "REG_FIRSTLASTNAME",
            "REG_SECONDLASTNAME",
            "REG_BIRTHDATE",
            "REG_GENDER",
            "REG_EMAIL",
            "REG_PHONE",
            "REG_EPS",
            "REG_HABEAS",
            "FILTRO_COLUMNA",
            "FILTRO_CONFIRM",
        ]);

        if (decision === "CHANGE_DATE") {
            if (currentState !== "AGENDAR") return null;
            if (AGENDAR_REGISTRATION_STEPS.has(currentStep)) return null;

            return {
                response:
                    "Claro, cambiemos la fecha. 😊\n\n" +
                    "¿Para qué fecha te gustaría agendar la cita? Escríbela en formato DD/MM, o dime tu preferencia (ej: \"lo más pronto posible\").\n\n" +
                    "0️⃣ Volver al menú",
                nextState: "AGENDAR",
                data: { ...data, step: "ASK_DATE" },
            };
        }

        // Preguntas de información (costos, teleconsulta, postoperatorio)
        // hechas a mitad de un agendamiento ya en curso: tratarlas como "saltar
        // de sección" perdería todo el registro que el paciente ya dio. Se
        // responden en el mismo lugar, como una pregunta abierta cualquiera,
        // sin abandonar el agendamiento (mientras no haya terminado: después
        // de POST_CREATED ya no hay nada que conservar).
        const isMidRegistration =
            currentState === "AGENDAR" &&
            currentStep &&
            currentStep !== "POST_CREATED";
        const infoSideTopics = new Set([
            "GO_INFO_COSTOS",
            "GO_TELECONSULTA",
            "GO_POST_SURGERY",
        ]);
        const effectiveDecision =
            isMidRegistration && infoSideTopics.has(decision)
                ? "OPEN_QUESTION"
                : decision;

        if (effectiveDecision === "TALK_TO_HUMAN") {
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

        if (effectiveDecision === "OPEN_QUESTION") {
            // Si ya conocemos su nombre (por esta u otra operación en la misma
            // sesión, vía la memoria de Fabian), se lo hacemos saber a la IA
            // para que no le hable como a un desconocido.
            const knownFirstName =
                data.firstName ||
                (data.fullName ? String(data.fullName).split(/\s+/)[0] : null);

            // Si ya hay una cita en curso/recién creada en esta sesión, se le
            // pasa la fecha/hora reales a la IA, y el estado ACTUAL consultado
            // en la base de datos (no una suposición), para que pueda
            // responder con datos concretos y verdaderos (ej: "sí, tu cita ya
            // quedó confirmada" o "todavía la estamos procesando") en vez de
            // una reafirmación genérica que podría no ser cierta en este
            // momento.
            let appointmentContext = "";
            if (data.date && data.time) {
                const realStatus = await getRealAppointmentStatus(
                    data.appointmentId,
                );
                const statusText =
                    realStatus === "CONFIRMED"
                        ? "Su cita YA QUEDÓ CONFIRMADA en el sistema."
                        : realStatus === "FAILED"
                          ? "Hubo un problema confirmando su cita en el sistema; nuestro equipo ya fue notificado y la resolverá manualmente."
                          : data.appointmentId
                            ? "Su solicitud todavía se está procesando en el sistema; aún NO ha sido confirmada."
                            : "Su solicitud quedó registrada pero todavía no se ha enviado a confirmar.";

                appointmentContext =
                    ` El paciente tiene una solicitud de cita para el ${data.date} a las ${data.time}. ${statusText}`;
            }

            const answer = await askAI(
                message,
                `\nEl paciente está en la sección "${currentState}"${currentStep ? ` (paso "${currentStep}")` : ""} del chatbot.` +
                    appointmentContext +
                    (knownFirstName
                        ? ` Ya sabes que se llama ${knownFirstName} (dato de esta sesión); puedes dirigirte a él/ella por su nombre si es natural, y no le pidas que se identifique de nuevo.`
                        : "") +
                    ' El mensaje puede ser una pregunta o simplemente una duda/preocupación sobre lo que acaba de pasar (ej: si algo quedó guardado). Respóndele de forma concreta y tranquilizadora con lo que sepas del contexto. Si su mensaje requiere agendar una cita, gestionar una cita existente o hablar con la secretaria, indícale brevemente cómo continuar (ej: escribir "agendar" o "0" para volver al menú), pero no inventes botones, pasos ni datos que no te dieron.',
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

        return destinationFor(effectiveDecision) || null;
    } catch (error) {
        console.error("❌ resolveFlowFallback error inesperado:", error);
        return null;
    }
}
