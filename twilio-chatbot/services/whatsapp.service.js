import twilio from "twilio";

const accountSid = process.env.TWILIO_ACCOUNT_SID;
const authToken = process.env.TWILIO_AUTH_TOKEN;

if (!accountSid || !authToken) {
    throw new Error(
        "Faltan TWILIO_ACCOUNT_SID o TWILIO_AUTH_TOKEN en variables de entorno.",
    );
}

const client = twilio(
    process.env.TWILIO_ACCOUNT_SID,
    process.env.TWILIO_AUTH_TOKEN,
);

function normalizeWhatsAppAddress(value, fallback = "") {
    const raw = String(value || fallback || "").trim();

    if (!raw) {
        throw new Error("Número WhatsApp no configurado.");
    }

    if (raw.startsWith("whatsapp:")) {
        return raw;
    }

    const cleaned = raw.replace(/\s+/g, "");
    return `whatsapp:${cleaned}`;
}

function normalizeTemplateVariables(variables) {
    if (
        !variables ||
        typeof variables !== "object" ||
        Array.isArray(variables)
    ) {
        return null;
    }

    const cleaned = Object.fromEntries(
        Object.entries(variables)
            .filter(([, value]) => value !== undefined && value !== null)
            .map(([key, value]) => [String(key), String(value)]),
    );

    return Object.keys(cleaned).length ? cleaned : null;
}

export async function sendWhatsAppTemplate(to, contentSid, variables = null) {
    const payload = {
        to: to.startsWith("whatsapp:") ? to : `whatsapp:${to}`,
        contentSid,
        messagingServiceSid: process.env.TWILIO_MESSAGING_SERVICE_SID,
    };

    const contentVariables = normalizeTemplateVariables(variables);
    if (contentVariables) {
        payload.contentVariables = JSON.stringify(contentVariables);
    }

    console.log("📤 Enviando template Twilio:", payload);

    return client.messages.create(payload);
}

const FROM_WHATSAPP = normalizeWhatsAppAddress(
    process.env.TWILIO_WHATSAPP_NUMBER,
    "+573114811385",
);

const SECRETARY_WHATSAPP = normalizeWhatsAppAddress(
    process.env.SECRETARY_WHATSAPP_NUMBER,
    "+573203269984",
);

export async function sendWhatsAppMessage(phone, body) {
    const to = normalizeWhatsAppAddress(phone);

    return client.messages.create({
        from: FROM_WHATSAPP,
        to,
        body,
    });
}

export async function sendWhatsAppMessageWithMedia(
    phone,
    body,
    mediaUrls = [],
) {
    const to = normalizeWhatsAppAddress(phone);

    const payload = {
        from: FROM_WHATSAPP,
        to,
        body,
    };

    if (Array.isArray(mediaUrls) && mediaUrls.length) {
        payload.mediaUrl = mediaUrls;
    }

    return client.messages.create(payload);
}

// "copy_img_postoperatorio": duplicado de la plantilla anterior que agrega
// el mensaje del paciente como {{4}} (antes no se mostraba) y corre la
// imagen a {{5}}. Ya aprobada por WhatsApp (confirmado 01-sep-2026). Si se
// sobreescribe TWILIO_POST_SURGERY_IMAGE_TEMPLATE_SID en el .env con el SID
// de la plantilla vieja ("img_postoperatorio", solo 4 variables), el envío
// falla con error 400 por el desajuste de variables — no dejar esa variable
// puesta a menos que sea con este mismo SID.
const POST_SURGERY_IMAGE_TEMPLATE_SID =
    process.env.TWILIO_POST_SURGERY_IMAGE_TEMPLATE_SID ||
    "HX6b921fbd838384cdb2dc178f88e8497e";

export async function notifySecretaryPostSurgeryImage({
    patientPhone,
    patientName = "Paciente postquirúrgico",
    patientDocument = "No disponible",
    note = "",
    mediaUrl,
}) {
    if (!mediaUrl) {
        throw new Error(
            "notifySecretaryPostSurgeryImage requiere una mediaUrl pública.",
        );
    }

    const variables = {
        1: patientName || "Paciente postquirúrgico",
        2: patientDocument || "No disponible",
        3: patientPhone || "No disponible",
        4: note && note.trim() ? note.trim() : "Sin mensaje adicional",
        5: mediaUrl,
    };

    console.log("📤 Enviando plantilla postoperatoria a secretaria:", {
        to: SECRETARY_WHATSAPP,
        contentSid: POST_SURGERY_IMAGE_TEMPLATE_SID,
        patientPhone,
        patientName,
        patientDocument,
        note,
        mediaUrl,
    });

    // En una Content Template de Twilio NO se envían body ni mediaUrl como
    // parámetros del Message. El ContentSid sustituye ambos y {{5}} recibe
    // la URL dinámica mediante ContentVariables.
    return sendWhatsAppTemplate(
        SECRETARY_WHATSAPP,
        POST_SURGERY_IMAGE_TEMPLATE_SID,
        variables,
    );
}

// Antes se enviaba como mensaje de texto libre, pero WhatsApp bloquea el
// texto libre business-initiated si la secretaria no le ha escrito al bot
// en las ultimas 24h (error 63016). Se cambio a plantilla aprobada, que no
// tiene esa restriccion.
const SECRETARY_NOTIFICATION_TEMPLATE_SID =
    process.env.TWILIO_SECRETARY_NOTIFICATION_TEMPLATE_SID ||
    "HX8eda3d18d10efe8ade4fa7427f96cd51";

export async function notifySecretarySupportRequest({
    patientPhone,
    patientName = "Paciente",
    reason = "Solicitud de atención",
    note = "",
}) {
    console.log("📤 Notificando solicitud a secretaria:", {
        to: SECRETARY_WHATSAPP,
        patientPhone,
        patientName,
        reason,
        hasNote: Boolean(note),
    });

    return sendWhatsAppTemplate(SECRETARY_WHATSAPP, SECRETARY_NOTIFICATION_TEMPLATE_SID, {
        1: patientName,
        2: patientPhone,
        3: reason,
        4: note && note.trim() ? note.trim() : "Sin mensaje adicional",
    });
}

// Twilio a veces todavía no tiene el archivo disponible en el instante en
// que llega el webhook (404 momentáneo). Reintentamos un par de veces con
// una espera corta antes de darlo por perdido.
function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function downloadTwilioMedia(mediaUrl, attempt = 1) {
    const maxAttempts = 3;
    const response = await fetch(mediaUrl, {
        headers: {
            Authorization:
                "Basic " +
                Buffer.from(`${accountSid}:${authToken}`).toString("base64"),
        },
    });

    if (!response.ok) {
        if (response.status === 404 && attempt < maxAttempts) {
            await sleep(1000 * attempt);
            return downloadTwilioMedia(mediaUrl, attempt + 1);
        }
        throw new Error(
            `No se pudo descargar media de Twilio. Status: ${response.status}`,
        );
    }

    const arrayBuffer = await response.arrayBuffer();
    return Buffer.from(arrayBuffer);
}
