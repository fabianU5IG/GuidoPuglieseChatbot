import { registerChatbotInteraction } from "../services/chatbot-db.service.js";
import { notifySecretarySupportRequest } from "../services/whatsapp.service.js";
import { resolveFlowFallback } from "../services/flowFallback.service.js";
import menuState from "./menu.state.js";

function normalize(value = "") {
    return String(value || "")
        .trim()
        .toLowerCase()
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "");
}

function isMenuIntent(msg) {
    const key = normalize(msg);
    return (
        key === "0" ||
        key === "menu" ||
        key === "inicio" ||
        key === "hola" ||
        key === "volver" ||
        key.includes("menu principal")
    );
}

function waitingResponse(data = {}) {
    return {
        response:
            "Tu solicitud está en espera de atención por la secretaria. Te responderemos por este mismo medio. Puedes escribir *MENÚ* o *0* para volver al menú principal.",
        nextState: "SECRETARIA",
        data: {
            ...data,
            waitingForSecretary: true,
            secretaryNotified: true,
        },
    };
}

export default async function secretariaState(msg, data = {}, context = {}) {
    if (isMenuIntent(msg)) {
        return menuState("menu", {}, context);
    }

    const directMenuOption = normalize(msg);
    if (["1", "2", "3", "4", "5"].includes(directMenuOption)) {
        return menuState(directMenuOption, {}, context);
    }

    // Importante: se prioriza `msg` (ya resuelto por index.js como
    // ButtonPayload cuando el mensaje viene de un botón, ej: "menu_secretaria")
    // sobre el texto crudo (context.rawBody.Body sería el texto visible del
    // botón, ej: "Sí, comunicarme"). Antes se usaba el texto crudo primero:
    // el chequeo de botón al inicio de resolveFlowFallback (que compara
    // contra el id exacto "menu_secretaria") nunca coincidía, la IA volvía a
    // clasificar el texto como "quiere hablar con alguien" y reenviaba la
    // misma tarjeta de confirmación en bucle infinito.
    const note = String(msg || context?.rawBody?.Body || "").trim();

    // Antes, cualquier mensaje del paciente mientras espera a la secretaria
    // (una pregunta real, una duda, "hola", lo que sea) solo repetía "tu
    // solicitud está en espera", sin importar qué escribiera. Ya notificado
    // el primer aviso, se le da a la IA la oportunidad de responder algo
    // útil; si no tiene certeza (mensaje ambiguo o info adicional del caso),
    // devuelve null y se sigue reenviando como antes.
    if (data.secretaryNotified && note) {
        const aiFallback = await resolveFlowFallback({
            message: note,
            currentState: "SECRETARIA",
            currentStep: data.reason || data.tipo || null,
            data,
            context,
        });
        if (aiFallback) return aiFallback;
    }

    if (!data.secretaryNotified) {
        try {
            await registerChatbotInteraction({
                phone: context.from,
                appointmentId: data.appointmentId || null,
                appointmentData: {
                    action: data.tipo || data.reason || "SECRETARY_SUPPORT",
                },
            });

            await notifySecretarySupportRequest({
                patientPhone: context.from,
                patientName: data.fullName || data.patientName || "Paciente",
                reason: data.reason || data.tipo || "Solicitud de atención",
                note,
            });
        } catch (error) {
            console.error("❌ No fue posible notificar a la secretaria:", error);
        }
    } else if (note) {
        try {
            await notifySecretarySupportRequest({
                patientPhone: context.from,
                patientName: data.fullName || data.patientName || "Paciente",
                reason: `${data.reason || data.tipo || "Solicitud de atención"} - información adicional`,
                note,
            });
        } catch (error) {
            console.error(
                "❌ No fue posible reenviar información adicional a secretaria:",
                error,
            );
        }
    }

    return waitingResponse(data);
}
