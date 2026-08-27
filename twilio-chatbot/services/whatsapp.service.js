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
    process.env.SECRETARY_PHONES,
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

const POST_SURGERY_IMAGE_TEMPLATE_SID =
    process.env.TWILIO_POST_SURGERY_IMAGE_TEMPLATE_SID ||
    "HXcc3965e4a999e2f451441930c63c51d8";

export async function notifySecretaryPostSurgeryImage({
    patientPhone,
    patientName = "Paciente postquirúrgico",
    patientDocument = "No disponible",
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
        4: mediaUrl,
    };

    console.log("📤 Enviando plantilla postoperatoria a secretaria:", {
        to: SECRETARY_WHATSAPP,
        contentSid: POST_SURGERY_IMAGE_TEMPLATE_SID,
        patientPhone,
        patientName,
        patientDocument,
        mediaUrl,
    });

    // En una Content Template de Twilio NO se envían body ni mediaUrl como
    // parámetros del Message. El ContentSid sustituye ambos y {{4}} recibe
    // la URL dinámica mediante ContentVariables.
    return sendWhatsAppTemplate(
        SECRETARY_WHATSAPP,
        POST_SURGERY_IMAGE_TEMPLATE_SID,
        variables,
    );
}

export async function notifySecretarySupportRequest({
    patientPhone,
    patientName = "Paciente",
    reason = "Solicitud de atención",
    note = "",
}) {
    const body =
        `📥 *Solicitud para secretaria*\n\n` +
        `👤 Paciente: ${patientName}\n` +
        `📞 Tel: ${patientPhone}\n` +
        `📌 Motivo: ${reason}` +
        (note ? `\n📝 Mensaje: ${note}` : "");

    console.log("📤 Notificando solicitud a secretaria:", {
        to: SECRETARY_WHATSAPP,
        patientPhone,
        patientName,
        reason,
        hasNote: Boolean(note),
    });

    return client.messages.create({
        from: FROM_WHATSAPP,
        to: SECRETARY_WHATSAPP,
        body,
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
