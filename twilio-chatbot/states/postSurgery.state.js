import {
    upsertPatientName,
    createSecretaryCase,
} from "../services/chatbot-db.service.js";
import {
    notifySecretaryPostSurgeryImage,
    notifySecretarySupportRequest,
    sendWhatsAppMessage,
    downloadTwilioMedia,
} from "../services/whatsapp.service.js";
import { savePatientImageToMySql } from "../services/post-surgery-media.service.js";
import { resolveFlowFallback } from "../services/flowFallback.service.js";

const TEMPLATE_MENU_PRINCIPAL = "HX8a87673651f780a2781725fb23872427";
const TEMPLATE_POSTOP_TIEMPO_CIRUGIA = "HXac4185b56c6a8f99a45e9aabc91b74ff";

function returnMenu() {
    return {
        response: null,
        nextState: "MENU",
        data: {},
        sendTemplate: true,
        template: { contentSid: TEMPLATE_MENU_PRINCIPAL, variables: null },
    };
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

function askPostSurgeryQuestion(data = {}) {
    return {
        response: null,
        nextState: "POST_SURGERY",
        data: { ...data, step: "ASK_POST_SURGERY_DAYS" },
        sendTemplate: true,
        template: { contentSid: TEMPLATE_POSTOP_TIEMPO_CIRUGIA, variables: null },
    };
}

function startPostOperativeAppointment(data = {}) {
    return {
        response:
            "Perfecto. Como ya han pasado 15 días o más desde la cirugía, vamos a agendar tu cita posoperatoria.\n\n" +
            "La IA podrá recomendarte fechas y horarios disponibles según tus preferencias.\n\n" +
            "Por favor escribe tu nombre completo:",
        nextState: "AGENDAR",
        data: {
            step: "ASK_NAME",
            origin: "POSOPERATORIO",
            consultationMode: "PRESENCIAL",
            aiSchedulingEnabled: true,
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
            const trimmedMsg = String(msg || "").trim();

            // Antes, cualquier texto que no fuera una foto (ej: "no sé cómo
            // mandar la foto", "no tengo cámara") repetía exactamente el mismo
            // mensaje en bucle, sin IA ni forma de escapar salvo el "0"
            // literal. Se intenta primero la navegación con IA (permite pedir
            // la secretaria, volver al menú, o responder una pregunta) antes
            // de repetir el reprompt.
            if (trimmedMsg) {
                const aiFallback = await resolveFlowFallback({
                    message: trimmedMsg,
                    currentState: "POST_SURGERY_WAIT_IMAGE",
                    currentStep: "AWAIT_IMAGE",
                    data,
                    context,
                });
                if (aiFallback) return aiFallback;
            }

            const attempts = Number(data.imageReminderAttempts || 0) + 1;

            const response =
                attempts >= 2
                    ? "😊 Entiendo, a veces cuesta encontrar cómo hacerlo.\n\n" +
                      "En WhatsApp, toca el ícono de 📎 (clip) o de cámara junto al cuadro de texto, elige o toma la foto de la zona postquirúrgica y envíala.\n\n" +
                      "Si prefieres que te ayude una persona, escribe *secretaria*. Si quieres salir, escribe 0️⃣."
                    : "Por favor envíame la foto de la zona postquirúrgica y, si quieres, acompáñala con un mensaje corto contándome qué notas.\n\nCuando la reciba, la reenviaré a la secretaria para revisión.\n\n0️⃣ Volver al menú";

            return {
                response,
                nextState: "POST_SURGERY_WAIT_IMAGE",
                data: { ...data, awaitingImage: true, imageReminderAttempts: attempts },
            };
        }

        const patientName =
            data.fullName || data.patientName || "Paciente postquirúrgico";
        const note = String(context.rawBody?.Body || "").trim();

        const documentTypeLabels = {
            1: "CC",
            2: "CE",
            4: "Pasaporte",
            5: "RC",
            6: "TI",
        };
        const documentNumber = String(
            data.patientDocumentNumber || data.documento || "",
        ).trim();
        const documentType = documentTypeLabels[Number(data.patientDocumentType)];
        const patientDocument = documentNumber
            ? `${documentType ? `${documentType} ` : ""}${documentNumber}`
            : "No disponible";

        let forwardedImages = 0;
        let lastForwardError = null;
        let lastStoredImageUrl = null;

        for (const mediaItem of incomingMedia) {
            if (!mediaItem?.url) continue;

            try {
                // 1) Twilio entrega una URL temporal/protegida. La descargamos
                //    usando Account SID + Auth Token.
                const fileBuffer = await downloadTwilioMedia(mediaItem.url);

                // 2) Guardamos la imagen en MySQL y generamos una URL pública
                //    propia, única y aleatoria para esta foto.
                const storedImage = await savePatientImageToMySql({
                    fileBuffer,
                    patientPhone: context.from,
                    patientName,
                    patientDocument,
                    note,
                    contentType: mediaItem.contentType || "image/jpeg",
                    publicBaseUrl: context.publicBaseUrl,
                });

                console.log("✅ URL dinámica propia:", storedImage.publicUrl);
                lastStoredImageUrl = storedImage.publicUrl;

                // 3) La plantilla de Twilio usa:
                //    {{1}} nombre, {{2}} documento, {{3}} teléfono, {{4}} mensaje del
                //    paciente, {{5}} imagen. Como la plantilla admite una sola Media
                //    URL, si llegan varias fotos enviamos una plantilla por cada una.
                await notifySecretaryPostSurgeryImage({
                    patientPhone: context.from,
                    patientName,
                    patientDocument,
                    note,
                    mediaUrl: storedImage.publicUrl,
                });

                forwardedImages += 1;
            } catch (error) {
                lastForwardError = error;
                console.error(
                    "❌ Error guardando/re-enviando imagen postoperatoria:",
                    error,
                );
            }
        }

        // Se guarda el caso en la base de datos SIEMPRE (haya fallado o no el
        // aviso por WhatsApp) para que quede visible desde "Ver casos
        // pendientes" del panel de secretaría — antes, si el mensaje de
        // WhatsApp fallaba o simplemente se perdía entre el resto de
        // conversaciones, no quedaba ningún registro consultable.
        try {
            await createSecretaryCase({
                patientPhone: context.from,
                patientName,
                patientDocument,
                reason: "POST_SURGERY_IMAGE",
                note,
                mediaUrl: lastStoredImageUrl,
            });
        } catch (caseError) {
            console.error(
                "❌ No fue posible registrar el caso de secretaría:",
                caseError,
            );
        }

        if (!forwardedImages) {
            try {
                await sendWhatsAppMessage(
                    process.env.SECRETARY_WHATSAPP_NUMBER,
                    `🩺 Post cirugía - imagen recibida\n\n👤 Paciente: ${patientName}\n📄 Documento: ${patientDocument}\n📞 Tel: ${context.from}\n📝 Mensaje: ${note || "Sin mensaje adicional"}\n\n⚠️ La imagen no pudo reenviarse automáticamente.`,
                );
            } catch (notifyError) {
                console.error(
                    "❌ Tampoco fue posible enviar el aviso de respaldo a secretaria:",
                    notifyError,
                );
            }

            return {
                response:
                    "Recibí tu imagen, pero tuve un inconveniente al enviarla automáticamente a la secretaria. Por favor intenta enviarla una vez más. Si el problema continúa, escribe *secretaria* para recibir ayuda.",
                nextState: "POST_SURGERY_WAIT_IMAGE",
                data: {
                    ...data,
                    awaitingImage: true,
                    imageForwardError: lastForwardError?.message || "UNKNOWN_ERROR",
                },
            };
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
        const supportPatientName =
            data.fullName || data.patientName || "Paciente postquirúrgico";
        const supportNote = String(context.rawBody?.Body || "").trim();

        try {
            await notifySecretarySupportRequest({
                patientPhone: context.from,
                patientName: supportPatientName,
                reason: "Soporte postquirúrgico",
                note: supportNote,
            });
        } catch (error) {
            console.error("❌ No fue posible notificar a la secretaria:", error);
        }

        try {
            await createSecretaryCase({
                patientPhone: context.from,
                patientName: supportPatientName,
                reason: "POST_SURGERY_SUPPORT",
                note: supportNote,
            });
        } catch (caseError) {
            console.error(
                "❌ No fue posible registrar el caso de secretaría:",
                caseError,
            );
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

    const aiFallback = await resolveFlowFallback({
        message: msg,
        currentState: "POST_SURGERY",
        currentStep: data.step || "ASK_POST_SURGERY_DAYS",
        data,
        context,
    });
    if (aiFallback) return aiFallback;

    return askPostSurgeryQuestion(data);
}
