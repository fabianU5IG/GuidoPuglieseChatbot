const SALUDTOOLS_HOST =
    process.env.SALUDTOOLS_HOST || "https://saludtools.carecloud.com.co/";
const SALUDTOOLS_APIKEY = process.env.SALUDTOOLS_APIKEY || "";
const SALUDTOOLS_APISECRET = process.env.SALUDTOOLS_APISECRET || "";

let cachedToken = null;
let cachedTokenExp = 0;
let authInFlight = null;

function authUrl() {
    return new URL(
        "integration/authenticate/apikey/v1/",
        SALUDTOOLS_HOST,
    ).toString();
}

function syncUrl() {
    return new URL("integration/sync/event/v1/", SALUDTOOLS_HOST).toString();
}

async function getJsonSafe(res) {
    const raw = await res.text().catch(() => "");
    try {
        return raw ? JSON.parse(raw) : null;
    } catch {
        return { raw };
    }
}

export async function authenticateSaludtools() {
    if (!SALUDTOOLS_APIKEY || !SALUDTOOLS_APISECRET) {
        throw new Error("Missing SALUDTOOLS_APIKEY / SALUDTOOLS_APISECRET");
    }

    const now = Date.now();

    if (cachedToken && now < cachedTokenExp - 30_000) {
        return cachedToken;
    }

    if (authInFlight) return authInFlight;

    authInFlight = (async () => {
        const res = await fetch(authUrl(), {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                key: SALUDTOOLS_APIKEY,
                secret: SALUDTOOLS_APISECRET,
            }),
        });

        const body = await getJsonSafe(res);

        if (!res.ok) {
            const err = new Error(`SaludTools auth failed (${res.status})`);
            err.status = res.status;
            err.response = body;
            throw err;
        }

        const token = body?.access_token || body?.token;
        if (!token) {
            const err = new Error("SaludTools auth token not found");
            err.response = body;
            throw err;
        }

        const expiresInSec = Number(body?.expires_in || 3600);
        cachedToken = token;
        cachedTokenExp = Date.now() + expiresInSec * 1000;

        return token;
    })();

    try {
        return await authInFlight;
    } finally {
        authInFlight = null;
    }
}

function validateBusinessResponse(eventType, actionType, payload) {
    const code = Number(payload?.code);

    if (Number.isFinite(code) && code !== 200 && code !== 201) {
        const err = new Error(
            `SaludTools ${eventType}/${actionType} business error (${code})`,
        );
        err.status = 200;
        err.businessCode = code;
        err.response = payload;
        throw err;
    }

    return payload;
}

export async function saludtoolsEvent({ eventType, actionType, body }) {
    const token = await authenticateSaludtools();

    const res = await fetch(syncUrl(), {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ eventType, actionType, body }),
    });

    const payload = await getJsonSafe(res);

    if (!res.ok) {
        const err = new Error(
            `SaludTools ${eventType}/${actionType} failed (${res.status})`,
        );
        err.status = res.status;
        err.response = payload;
        throw err;
    }

    return validateBusinessResponse(eventType, actionType, payload);
}

// =====================
// PATIENT
// =====================

export async function readPatientInSaludtools(documentType, documentNumber) {
    return saludtoolsEvent({
        eventType: "PATIENT",
        actionType: "READ",
        body: {
            documentType: Number(documentType),
            documentNumber: String(documentNumber),
        },
    });
}

export async function searchPatientInSaludtools(
    documentNumber,
    firstName = "",
) {
    return saludtoolsEvent({
        eventType: "PATIENT",
        actionType: "SEARCH",
        body: {
            firstName: String(firstName || ""),
            documentNumber: String(documentNumber),
            pageable: {
                page: 0,
                size: 20,
            },
        },
    });
}

export async function createPatientInSaludtools(patientBody) {
    return saludtoolsEvent({
        eventType: "PATIENT",
        actionType: "CREATE",
        body: patientBody,
    });
}

// =====================
// APPOINTMENT
// =====================

export async function searchAppointmentsInSaludtools({
    doctorDocumentType,
    doctorDocumentNumber,
    startAppointment,
    endAppointment,
    page = 0,
    size = 20,
}) {
    return saludtoolsEvent({
        eventType: "APPOINTMENT",
        actionType: "SEARCH",
        body: {
            doctorDocumentType: Number(doctorDocumentType),
            doctorDocumentNumber: String(doctorDocumentNumber),
            startAppointment: String(startAppointment),
            endAppointment: String(endAppointment),
            pageable: {
                page: Number(page),
                size: Number(size),
            },
        },
    });
}

export async function searchAppointmentsByPatientInSaludtools({
    patientDocumentType,
    patientDocumentNumber,
    page = 0,
    size = 20,
}) {
    return saludtoolsEvent({
        eventType: "APPOINTMENT",
        actionType: "SEARCH",
        body: {
            patientDocumentType: Number(patientDocumentType),
            patientDocumentNumber: String(patientDocumentNumber),
            pageable: {
                page: Number(page),
                size: Number(size),
            },
        },
    });
}

export async function createAppointmentInSaludtools(appointmentBody) {
    return saludtoolsEvent({
        eventType: "APPOINTMENT",
        actionType: "CREATE",
        body: {
            ...appointmentBody,
            startAppointment: String(appointmentBody.startAppointment || ""),
            endAppointment: String(appointmentBody.endAppointment || ""),
        },
    });
}

export async function updateAppointmentInSaludtools(appointmentBody) {
    return saludtoolsEvent({
        eventType: "APPOINTMENT",
        actionType: "UPDATE",
        body: {
            ...appointmentBody,
            id: String(appointmentBody.id || ""),
            startAppointment: String(appointmentBody.startAppointment || ""),
            endAppointment: String(appointmentBody.endAppointment || ""),
        },
    });
}

export async function deleteAppointmentInSaludtools({ id }) {
    return saludtoolsEvent({
        eventType: "APPOINTMENT",
        actionType: "DELETE",
        body: {
            id: String(id),
        },
    });
}
