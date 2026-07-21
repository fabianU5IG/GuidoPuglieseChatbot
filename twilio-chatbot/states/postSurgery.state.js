import { upsertPatientName } from "../services/chatbot-db.service.js";
import {
    notifySecretaryPostSurgeryImage,
    notifySecretarySupportRequest,
    sendWhatsAppMessage,
    downloadTwilioMedia,
} from "../services/whatsapp.service.js";
import { uploadPatientImageToSupabase } from "../services/supabase.service.js";

function returnMenu() {
    return { response: null, nextState: "MENU", data: { renderMenu: true } };
}

function normalize(value = "") {
    return String(value || "")
        .trim()
        .toLowerCase()
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "");
}

function parsePostSurgeryDays(msg) {
    const raw = normalize(msg);
    const match = raw.match(/\b(\d{1,3})\b/);
    return match ? Number(match[1]) : null;
}

function buildPostSurgeryQuestion() {
    return (
        "Para orientarte correctamente, indícanos cuánto tiempo ha pasado desde la cirugía:\n\n" +
        "1️⃣ Han pasado 15 días o más: agendar cita posoperatoria\n" +
        "2️⃣ Han pasado menos de 15 días: enviar imágenes para revisión\n" +
        "3️⃣ Hablar con la secretaria\n" +
        "0️⃣ Volver al menú"
    );
}

function startPostOperativeAppointment(data = {}) {
    return {
        response:
            "Perfecto. Como ya han pasado 15 días o más desde la cirugía, vamos a agendar tu cita posoperatoria.\n\nPor favor escribe tu nombre completo:",
        nextState: "AGENDAR",
        data: {
            step: "ASK_NAME",
            appointmentType: "Cita posoperatoria",
            appointmentReason: "POSOPERATORIO_15_DIAS",
            isPostOperative: true,
            postSurgeryDays: data.postSurgeryDays || 15,
        },
    };
}

function requestPostSurgeryImage(data = {}) {
    return {
        response:
            "Perfecto. Envíame la foto de la zona postquirúrgica.\n\nPuedes escribir un mensaje corto junto con la imagen explicando qué molestias, cambios o señales has notado.\n\nApenas la reciba, la reenviaré a la secretaria.\n\n0️⃣ Volver al menú",
        nextState: "POST_SURGERY_WAIT_IMAGE",
        data: { ...data, awaitingImage: true },
    };
}

export default async function postSurgeryState(msg, data = {}, context = {}) {
    if (msg === "0") return returnMenu();

    if (context?.from && data?.fullName) {
        await upsertPatientName(context.from, data.fullName);
    }

    const incomingMedia = Array.isArray(context.media) ? context.media : [];
    const mediaUrls = incomingMedia.map((item) => item.url).filter(Boolean);

    if (data.awaitingImage) {
        if (!mediaUrls.length) {
            return {
                response:
                    "Por favor envíame la foto de la zona postquirúrgica y, si quieres, acompáñala con un mensaje corto contándome qué notas.\n\nCuando la reciba, la reenviaré a la secretaria para revisión.\n\n0️⃣ Volver al menú",
                nextState: "POST_SURGERY_WAIT_IMAGE",
                data: { ...data, awaitingImage: true },
            };
        }

        const patientName =
            data.fullName || data.patientName || "Paciente postquirúrgico";
        const note = String(context.rawBody?.Body || "").trim();

        try {
            const publicMediaUrls = [];

            for (const mediaItem of incomingMedia) {
                if (!mediaItem?.url) continue;

                const fileBuffer = await downloadTwilioMedia(mediaItem.url);
                const uploadResult = await uploadPatientImageToSupabase({
                    fileBuffer,
                    patientPhone: context.from,
                    contentType: mediaItem.contentType || "image/jpeg",
                });

                publicMediaUrls.push(uploadResult.publicUrl);
            }

            console.log("✅ URLs públicas Supabase:", publicMediaUrls);

            await notifySecretaryPostSurgeryImage({
                patientPhone: context.from,
                patientName,
                note,
                mediaUrls: publicMediaUrls,
            });
        } catch (error) {
            console.error("❌ Error subiendo a Supabase o reenviando:", error);

            await sendWhatsAppMessage(
                process.env.SECRETARY_WHATSAPP_NUMBER,
                `🩺 Post cirugía - imagen recibida\n\n👤 Paciente: ${patientName}\n📞 Tel: ${context.from}\n📝 Mensaje: ${note || "Sin mensaje adicional"}\n\n⚠️ La imagen no pudo reenviarse automáticamente.`,
            );
        }

        return {
            response:
                "Gracias. Ya recibí tu imagen y la envié a la secretaria para revisión. Tu caso quedó en espera; no necesitas seleccionar ni enviar más opciones. Te responderemos por este mismo medio.",
            nextState: "SECRETARIA",
            data: {
                reason: "POST_SURGERY_IMAGE",
                patientName,
                forwardedImages: true,
                waitingForSecretary: true,
                secretaryNotified: true,
            },
        };
    }

    const normalized = normalize(msg);
    const days = parsePostSurgeryDays(msg);

    if (
        msg === "1" ||
        (Number.isFinite(days) && days >= 15) ||
        normalized.includes("15 dias o mas") ||
        normalized.includes("mas de 15")
    ) {
        return startPostOperativeAppointment({
            ...data,
            postSurgeryDays: days || 15,
        });
    }

    if (
        msg === "2" ||
        (Number.isFinite(days) && days >= 0 && days < 15) ||
        normalized.includes("menos de 15")
    ) {
        return requestPostSurgeryImage({
            ...data,
            postSurgeryDays: Number.isFinite(days) ? days : null,
        });
    }

    if (msg === "3" || normalized.includes("secretaria")) {
        try {
            await notifySecretarySupportRequest({
                patientPhone: context.from,
                patientName:
                    data.fullName ||
                    data.patientName ||
                    "Paciente postquirúrgico",
                reason: "Soporte postquirúrgico",
                note: String(context.rawBody?.Body || "").trim(),
            });
        } catch (error) {
            console.error("❌ No fue posible notificar a la secretaria:", error);
        }

        return {
            response:
                "Tu solicitud fue enviada a la secretaria y quedó en espera. No necesitas seleccionar ni enviar más opciones; te responderemos por este mismo medio.",
            nextState: "SECRETARIA",
            data: {
                reason: "POST_SURGERY_SUPPORT",
                waitingForSecretary: true,
                secretaryNotified: true,
            },
        };
    }

    return {
        response: buildPostSurgeryQuestion(),
        nextState: "POST_SURGERY",
        data: { ...data, step: "ASK_POST_SURGERY_DAYS" },
    };
}
