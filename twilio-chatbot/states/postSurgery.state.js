import gestionCitasState from "./gestionCitas.state.js";
import { upsertPatientName } from "../services/chatbot-db.service.js";
import {
    notifySecretaryPostSurgeryImage,
    sendWhatsAppMessage,
    downloadTwilioMedia,
} from "../services/whatsapp.service.js";
import { uploadPatientImageToSupabase } from "../services/supabase.service.js";

function returnMenu() {
    return { response: null, nextState: "MENU", data: { renderMenu: true } };
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
                "Gracias. Ya recibí tu imagen y la envié a la secretaria para revisión.\n\nSi necesitas agregar otra foto o más detalles, puedes enviarlos ahora o escribir *SECRETARIA*.",
            nextState: "SECRETARIA",
            data: {
                reason: "POST_SURGERY_IMAGE",
                forwardedImages: true,
            },
        };
    }

    switch (msg) {
        case "1":
            return {
                response:
                    "Perfecto. Envíame la foto de la zona postquirúrgica.\n\nPuedes escribir un mensaje corto junto con la imagen explicando qué molestias, cambios o señales has notado.\n\nApenas la reciba, la reenviaré a la secretaria.\n\n0️⃣ Volver al menú",
                nextState: "POST_SURGERY_WAIT_IMAGE",
                data: { ...data, awaitingImage: true },
            };

        case "2":
            return gestionCitasState("", {});

        case "3":
            return {
                response:
                    "Te comunicaré con la secretaria para continuar con tu caso postquirúrgico.",
                nextState: "SECRETARIA",
                data: { reason: "POST_SURGERY_SUPPORT" },
            };

        default:
            return {
                response:
                    "Si presentas:\n\n• Supuración de herida\n• Cambios extraños\n• Dolor intenso\n\nPuedes enviarnos fotos para que el Dr. las revise.\n\n1️⃣ Enviar imágenes\n2️⃣ Agendar cita de control\n3️⃣ Hablar con secretaria\n0️⃣ Volver al menú",
                nextState: "POST_SURGERY",
                data,
            };
    }
}
