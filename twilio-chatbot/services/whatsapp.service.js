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

export async function sendWhatsAppTemplate(to, contentSid, variables = null) {
    const payload = {
        to: to.startsWith("whatsapp:") ? to : `whatsapp:${to}`,
        contentSid,
        messagingServiceSid: process.env.TWILIO_MESSAGING_SERVICE_SID,
    };

    if (variables) {
        payload.contentVariables = JSON.stringify(variables);
    }

    console.log("📤 Enviando template Twilio:", payload);

    const response = await client.messages.create(payload);

    console.log("✅ Respuesta Twilio template:", {
        sid: response.sid,
        status: response.status,
        errorCode: response.errorCode,
        errorMessage: response.errorMessage,
    });

    return response;
}

const FROM_WHATSAPP = normalizeWhatsAppAddress(
    process.env.TWILIO_WHATSAPP_NUMBER,
    "+573114811385",
);

const SECRETARY_WHATSAPP = normalizeWhatsAppAddress(
    process.env.SECRETARY_WHATSAPP_NUMBER,
    "+573224811542",
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

export async function notifySecretaryPostSurgeryImage({
    patientPhone,
    patientName = "Paciente postquirúrgico",
    note = "",
    mediaUrls = [],
}) {
    const body =
        `🩺 *Post cirugía - imágenes recibidas*\n\n` +
        `👤 Paciente: ${patientName}\n` +
        `📞 Tel: ${patientPhone}\n` +
        `📝 Mensaje: ${note || "Sin mensaje adicional"}`;

    console.log("📤 Reenviando a secretaria:", {
        to: SECRETARY_WHATSAPP,
        patientPhone,
        patientName,
        note,
        mediaUrls,
    });

    return client.messages.create({
        from: FROM_WHATSAPP,
        to: SECRETARY_WHATSAPP,
        body,
        ...(Array.isArray(mediaUrls) && mediaUrls.length
            ? { mediaUrl: mediaUrls }
            : {}),
    });
}

export async function downloadTwilioMedia(mediaUrl) {
    const response = await fetch(mediaUrl, {
        headers: {
            Authorization:
                "Basic " +
                Buffer.from(`${accountSid}:${authToken}`).toString("base64"),
        },
    });

    if (!response.ok) {
        throw new Error(
            `No se pudo descargar media de Twilio. Status: ${response.status}`,
        );
    }

    const arrayBuffer = await response.arrayBuffer();
    return Buffer.from(arrayBuffer);
}
