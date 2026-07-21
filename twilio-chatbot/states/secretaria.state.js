import { registerChatbotInteraction } from "../services/chatbot-db.service.js";
import { notifySecretarySupportRequest } from "../services/whatsapp.service.js";

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
        key === "volver" ||
        key.includes("menu principal")
    );
}

function waitingResponse(data = {}) {
    return {
        response:
            "Tu solicitud está en espera de atención por la secretaria. No necesitas seleccionar ni enviar más opciones; te responderemos por este mismo medio.",
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
        return {
            response: null,
            nextState: "MENU",
            data: { renderMenu: true },
        };
    }

    const note = String(context?.rawBody?.Body || msg || "").trim();

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
