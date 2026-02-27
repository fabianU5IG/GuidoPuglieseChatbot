import timeUtils from "../utils/time.js";
import {
    createProposedAppointment,
    confirmAppointment,
    logAppointmentMessage,
    upsertPatientName,
} from "../services/chatbot-db.service.js";
import { notifySecretaryNewAppointment } from "./whatsapp.service.js";
import {
    enqueueSaludtoolsRequest,
    getSaludtoolsQueueSize,
} from "../services/saludtools-rate-limit.service.js";
const { getTimeSlots } = timeUtils;

/**
 * SALUDTOOLS
 * - Auth:  POST https://saludtools.carecloud.com.co/integration/authenticate/apikey/v1/
 * - Sync:  POST https://saludtools.carecloud.com.co/integration/sync/event/v1/
 *
 * Patient Search:
 * {
 *   "eventType":"PATIENT",
 *   "actionType":"SEARCH",
 *   "body": { "firstName":"Daris", "documentNumber":"32789925", "pageable":{ "page":0, "size":20 } }
 * }
 *
 * Patient Create:
 * {
 *   "eventType":"PATIENT",
 *   "actionType":"CREATE",
 *   "body": {
 *     "firstName":"Luis", "secondName":"Andres", "firstLastName":"Gutierrez", "secondLastName":"Gamez",
 *     "birthDate":"1967-12-05", "gender":2,
 *     "documentType":1, "documentNumber":"177400432",
 *     "phone":"3144780243", "cellPhone":"3144780243",
 *     "email":"lzarate@carecloud.com.co", "eps":3, "habeasData":false
 *   }
 * }
 *
 * Appointment Create:
 * { "eventType":"APPOINTMENT", "actionType":"CREATE", "body": { ... } }
 */

// ====== CONFIG (ENV) ======
const SALUDTOOLS_HOST =
    process.env.SALUDTOOLS_HOST || "https://saludtools.carecloud.com.co/";
const SALUDTOOLS_APIKEY = process.env.SALUDTOOLS_APIKEY || "";
const SALUDTOOLS_APISECRET = process.env.SALUDTOOLS_APISECRET || "";

// ✅ NO cruzar en .env:
// SALUDTOOLS_DOCTOR_DOCUMENT_NUMBER=72134079
// SALUDTOOLS_CLINIC_ID=18569
const DOCTOR_DOCUMENT_TYPE = Number(
    process.env.SALUDTOOLS_DOCTOR_DOCUMENT_TYPE || 1,
);
const DOCTOR_DOCUMENT_NUMBER =
    process.env.SALUDTOOLS_DOCTOR_DOCUMENT_NUMBER || "72134079";
const CLINIC_ID = Number(process.env.SALUDTOOLS_CLINIC_ID || 18569);

// Cita
const APPOINTMENT_DURATION_MIN = Number(
    process.env.SALUDTOOLS_APPOINTMENT_DURATION_MIN || 30,
);
const APPOINTMENT_MODALITY =
    process.env.SALUDTOOLS_APPOINTMENT_MODALITY || "CONVENTIONAL";
const APPOINTMENT_STATE = process.env.SALUDTOOLS_APPOINTMENT_STATE || "PENDING";
const APPOINTMENT_TYPE_DEFAULT =
    process.env.SALUDTOOLS_APPOINTMENT_TYPE || "Pruebas Luis";

// ✅ Circuit breaker de AUTH (evita spamear 429)
const AUTH_BLOCK_MINUTES = Number(
    process.env.SALUDTOOLS_AUTH_BLOCK_MINUTES || 5,
);

// ====== DEBUG LOGGING ======
const SALUDTOOLS_DEBUG =
    String(process.env.SALUDTOOLS_DEBUG || "").toLowerCase() === "true" ||
    process.env.SALUDTOOLS_DEBUG === "1";

function safeJson(obj, max = 1800) {
    try {
        const s = JSON.stringify(obj, null, 2);
        return s.length > max ? s.slice(0, max) + " ...[truncated]" : s;
    } catch {
        return String(obj);
    }
}

async function logSaludtools(appointmentId, label, payload) {
    const line = `[SALUDTOOLS] ${label} | ${safeJson(payload, 1800)}`;
    if (SALUDTOOLS_DEBUG) console.log(line);
    if (appointmentId)
        await logAppointmentMessage(appointmentId, line.slice(0, 1800));
}

// ====== Token cache (memory + data) ======
let cachedToken = null;
let cachedTokenExp = 0; // epoch ms
let authInFlight = null; // promise lock

function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
}

function saludtoolsSyncUrl() {
    return new URL("integration/sync/event/v1/", SALUDTOOLS_HOST).toString();
}

// ✅ Auth robusto + circuit breaker
async function authenticateSaludtools(appointmentId = null, meta = {}) {
    const { context = {}, data = {} } = meta;

    if (!SALUDTOOLS_APIKEY || !SALUDTOOLS_APISECRET) {
        await logSaludtools(
            appointmentId,
            "AUTH_SKIPPED (missing key/secret)",
            {
                hasKey: !!SALUDTOOLS_APIKEY,
                hasSecret: !!SALUDTOOLS_APISECRET,
            },
        );
        return {
            ok: false,
            skipped: true,
            token: null,
            error: "Missing credentials",
        };
    }

    const now = Date.now();

    // ✅ Circuit breaker: si ya sabemos que está rate-limited, no insistimos
    if (
        data.saludtoolsAuthBlockedUntil &&
        now < data.saludtoolsAuthBlockedUntil
    ) {
        await logSaludtools(appointmentId, "AUTH_BLOCKED_SKIP", {
            blockedUntil: data.saludtoolsAuthBlockedUntil,
            ttlMs: data.saludtoolsAuthBlockedUntil - now,
        });
        return { ok: false, token: null, code: 429, error: "AUTH_BLOCKED" };
    }

    // 1) Token en data (persistente por conversación)
    if (
        data.saludtoolsToken &&
        data.saludtoolsTokenExp &&
        now < data.saludtoolsTokenExp - 30_000
    ) {
        await logSaludtools(appointmentId, "AUTH_DATA_TOKEN_HIT", {
            exp: data.saludtoolsTokenExp,
            ttlMs: data.saludtoolsTokenExp - now,
        });
        return { ok: true, token: data.saludtoolsToken };
    }

    // 2) Cache del proceso
    if (cachedToken && now < cachedTokenExp - 30_000) {
        await logSaludtools(appointmentId, "AUTH_CACHE_HIT", {
            cachedTokenExp,
            ttlMs: cachedTokenExp - now,
        });
        data.saludtoolsToken = cachedToken;
        data.saludtoolsTokenExp = cachedTokenExp;
        return { ok: true, token: cachedToken };
    }

    // 3) Lock inflight
    if (authInFlight) {
        await logSaludtools(appointmentId, "AUTH_INFLIGHT_WAIT", {});
        try {
            const token = await authInFlight;
            return { ok: true, token };
        } catch {
            // sigue a intentar
        }
    }

    const url = new URL(
        "integration/authenticate/apikey/v1/",
        SALUDTOOLS_HOST,
    ).toString();
    data.authAttempt = (data.authAttempt || 0) + 1;

    const reqId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;

    const doAuthOnce = async () => {
        await logSaludtools(appointmentId, "AUTH_REQUEST", {
            reqId,
            ts: new Date().toISOString(),
            url,
            flow: { step: data?.step || null, authAttempt: data.authAttempt },
            ctx: { from: context?.from || null, state: context?.state || null },
            cache: { hasCachedToken: !!cachedToken, cachedTokenExp },
            body: { key: "[provided]", secret: "[hidden]" },
        });

        const res = await enqueueSaludtoolsRequest(() =>
            fetch(url, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    key: SALUDTOOLS_APIKEY,
                    secret: SALUDTOOLS_APISECRET,
                }),
            }),
        );

        await logSaludtools(appointmentId, "AUTH_RESPONSE_HEADERS", {
            reqId,
            status: res.status,
            retryAfter: res.headers.get("retry-after"),
        });

        if (res.status === 429)
            throw Object.assign(new Error("AUTH_429"), { code: 429 });

        const raw = await res.text().catch(() => "");
        let json = null;
        try {
            json = raw ? JSON.parse(raw) : null;
        } catch {}

        await logSaludtools(appointmentId, "AUTH_RESPONSE", {
            reqId,
            status: res.status,
            ok: res.ok,
            raw: raw?.slice(0, 1200),
            parsedKeys: json ? Object.keys(json) : null,
        });

        if (!res.ok)
            throw new Error(`Saludtools auth failed (${res.status}): ${raw}`);

        const token = json?.access_token || json?.token || null;
        if (!token)
            throw new Error("Saludtools auth: token not found in response");

        const expiresInSec = Number(json?.expires_in || 3600);
        cachedToken = token;
        cachedTokenExp = Date.now() + expiresInSec * 1000;
        data.saludtoolsToken = token;
        data.saludtoolsTokenExp = cachedTokenExp;

        await logSaludtools(appointmentId, "AUTH_TOKEN_SET", {
            reqId,
            expiresInSec,
            cachedTokenExp,
        });

        return token;
    };

    authInFlight = (async () => {
        const maxAttempts = 3;
        for (let i = 1; i <= maxAttempts; i++) {
            try {
                return await doAuthOnce();
            } catch (e) {
                if (e?.code === 429 || e?.message === "AUTH_429") {
                    const waitSec = Math.min(2 ** i, 12); // 2,4,8
                    await logSaludtools(appointmentId, "AUTH_429_BACKOFF", {
                        attempt: i,
                        waitSec,
                    });
                    await sleep(waitSec * 1000);
                    continue;
                }
                throw e;
            }
        }

        // ✅ activa bloqueo por X minutos para no spamear el AUTH
        data.saludtoolsAuthBlockedUntil =
            Date.now() + AUTH_BLOCK_MINUTES * 60_000;
        throw Object.assign(new Error("AUTH_429_FINAL"), { code: 429 });
    })();

    try {
        const token = await authInFlight;
        return { ok: true, token };
    } catch (e) {
        await logSaludtools(appointmentId, "AUTH_FAILED", {
            error: String(e?.message || e),
            code: e?.code,
            blockedUntil: data.saludtoolsAuthBlockedUntil || null,
        });
        return {
            ok: false,
            token: null,
            error: String(e?.message || e),
            code: e?.code,
        };
    } finally {
        authInFlight = null;
    }
}

// ====== Utils ======
function returnToMenu() {
    return { response: null, nextState: "MENU", data: { renderMenu: true } };
}

function normalizeDocType(msg) {
    const v = String(msg || "")
        .trim()
        .toLowerCase();
    if (v === "1" || v === "cc") return 1;
    if (v === "2" || v === "ce") return 2;
    return null;
}

function parsePhoneE164ToDigits(phone) {
    const digits = String(phone || "").replace(/\D/g, "");
    if (digits.startsWith("57") && digits.length >= 12) return digits.slice(2);
    return digits;
}

function splitName(fullName = "") {
    const parts = String(fullName).trim().split(/\s+/).filter(Boolean);
    return {
        firstName: parts[0] || "",
        secondName: parts.length >= 3 ? parts[1] : "",
        firstLastName: parts.length >= 2 ? parts[parts.length - 2] : "",
        secondLastName:
            parts.length >= 4
                ? parts[parts.length - 1]
                : parts.length === 3
                  ? parts[2]
                  : "",
    };
}

function isValidDateDDMM(value) {
    if (!/^\d{2}\/\d{2}$/.test(value)) return false;
    const [day, month] = value.split("/").map(Number);
    const year = new Date().getFullYear();
    const date = new Date(year, month - 1, day);
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    return !isNaN(date) && date >= today;
}

function ddmmToYmd(ddmm) {
    const [day, month] = ddmm.split("/").map(Number);
    const year = new Date().getFullYear();
    const d = new Date(year, month - 1, day);
    const yyyy = String(d.getFullYear()).padStart(4, "0");
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    const dd = String(d.getDate()).padStart(2, "0");
    return `${yyyy}-${mm}-${dd}`;
}

function addMinutesToYmdHm(ymd, hm, minutesToAdd) {
    const [H, M] = hm.split(":").map(Number);
    const [Y, Mo, D] = ymd.split("-").map(Number);
    const dt = new Date(Y, Mo - 1, D, H, M, 0, 0);
    dt.setMinutes(dt.getMinutes() + minutesToAdd);
    const yyyy = String(dt.getFullYear()).padStart(4, "0");
    const mm = String(dt.getMonth() + 1).padStart(2, "0");
    const dd = String(dt.getDate()).padStart(2, "0");
    const hh = String(dt.getHours()).padStart(2, "0");
    const min = String(dt.getMinutes()).padStart(2, "0");
    return { ymd: `${yyyy}-${mm}-${dd}`, hm: `${hh}:${min}` };
}

function isValidBirthDateYmd(value) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const d = new Date(value + "T00:00:00");
    return !isNaN(d.getTime());
}

function normalizeEmail(value) {
    const s = String(value || "").trim();
    if (!s) return "";
    const ok = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
    return ok ? s : null;
}

// ====== VALIDACIONES: Patient Create ======
const ALLOWED_DOC_TYPES = new Set([1, 2]); // 1=CC, 2=CE
const ALLOWED_GENDERS = new Set([1, 2]);

function collapseSpaces(s) {
    return String(s || "")
        .replace(/\s+/g, " ")
        .trim();
}

// Permite letras (incluye acentos), espacios, guion y apóstrofe. Quita caracteres raros.
function sanitizeName(s) {
    const v = collapseSpaces(s);
    const cleaned = v.replace(/[^A-Za-zÁÉÍÓÚÜÑáéíóúüñ\s'-]/g, "");
    return collapseSpaces(cleaned);
}

function isValidDigits(str, min, max) {
    const v = String(str || "");
    if (!/^\d+$/.test(v)) return false;
    return v.length >= min && v.length <= max;
}

// Tel: aceptamos 7-15 dígitos (E.164 sin '+')
function isValidPhoneDigits(v) {
    return isValidDigits(v, 7, 15);
}

function validateAndNormalizePatientBody(patientBody) {
    const b = { ...patientBody };

    // Sanitizar nombres
    b.firstName = sanitizeName(b.firstName);
    b.secondName = sanitizeName(b.secondName);
    b.firstLastName = sanitizeName(b.firstLastName);
    b.secondLastName = sanitizeName(b.secondLastName);

    // Normalizar tipos numéricos
    b.gender = Number(b.gender);
    b.documentType = Number(b.documentType);

    // Normalizar strings
    b.documentNumber = String(b.documentNumber || "").trim();
    b.birthDate = String(b.birthDate || "").trim();
    b.email = String(b.email || "").trim();

    // Phone digits
    b.phone = String(b.phone || "").trim();
    b.cellPhone = String(b.cellPhone || "").trim();

    // EPS: si viene vacío o 0 -> 0
    const epsNum = Number(b.eps || 0);
    b.eps = Number.isFinite(epsNum) && epsNum > 0 ? epsNum : 0;

    // habeasData boolean
    b.habeasData = Boolean(b.habeasData);

    // ====== Validaciones requeridas ======
    if (!b.firstName || b.firstName.length < 2) {
        return {
            ok: false,
            step: "REG_FIRSTNAME",
            message: "Primer nombre inválido. Escríbelo nuevamente:",
        };
    }
    if (!b.firstLastName || b.firstLastName.length < 2) {
        return {
            ok: false,
            step: "REG_FIRSTLASTNAME",
            message: "Primer apellido inválido. Escríbelo nuevamente:",
        };
    }

    if (!isValidBirthDateYmd(b.birthDate)) {
        return {
            ok: false,
            step: "REG_BIRTHDATE",
            message: "Fecha inválida. Usa YYYY-MM-DD. Ej: 1967-12-05",
        };
    }

    if (!ALLOWED_GENDERS.has(b.gender)) {
        return {
            ok: false,
            step: "REG_GENDER",
            message: "Elige 1 o 2, o 0 para volver al menú.",
        };
    }

    if (!ALLOWED_DOC_TYPES.has(b.documentType)) {
        return {
            ok: false,
            step: "ASK_DOC_TYPE",
            message:
                "Selecciona tu tipo de documento:\n\n1️⃣ CC\n2️⃣ CE\n\n0️⃣ Volver al menú",
        };
    }
    if (!isValidDigits(b.documentNumber, 5, 20)) {
        return {
            ok: false,
            step: "ASK_DOC_NUMBER",
            message:
                "Número inválido. Por favor escribe solo números (mínimo 5 dígitos):",
        };
    }

    if (!isValidPhoneDigits(b.phone) || !isValidPhoneDigits(b.cellPhone)) {
        return {
            ok: false,
            step: "REG_HABEAS",
            message:
                "No pude validar el número de contacto. Intentemos nuevamente la confirmación de datos (Habeas Data):\n\n1️⃣ Sí, autorizo\n2️⃣ No autorizo\n\n0️⃣ Volver al menú",
        };
    }

    // Email: opcional, pero si viene debe ser válido
    if (b.email) {
        const em = normalizeEmail(b.email);
        if (em === null) {
            return {
                ok: false,
                step: "REG_EMAIL",
                message: "Correo inválido. Intenta de nuevo o escribe 0:",
            };
        }
        b.email = em;
    } else {
        b.email = "";
    }

    return { ok: true, body: b };
}

function extractPatientItems(searchJson) {
    const content =
        searchJson?.body?.content ??
        searchJson?.body?.data ??
        searchJson?.body ??
        searchJson?.content ??
        searchJson?.data ??
        searchJson;
    if (Array.isArray(content)) return content;
    if (Array.isArray(content?.content)) return content.content;
    if (Array.isArray(content?.items)) return content.items;
    return [];
}

function isPatientActiveFromItem(item) {
    if (!item || typeof item !== "object") return true;
    const active = item.active ?? item.isActive ?? item.enabled;
    if (typeof active === "boolean") return active;

    const status = String(
        item.status || item.state || item.patientStatus || "",
    ).toLowerCase();
    if (!status) return true;
    const inactiveTokens = [
        "inactive",
        "inactivo",
        "disabled",
        "deshabilitado",
        "blocked",
        "bloqueado",
        "suspended",
        "suspendido",
    ];
    return !inactiveTokens.some((t) => status.includes(t));
}

// ====== SALUDTOOLS: PATIENT SEARCH ======
async function saludtoolsSearchPatient({
    appointmentId = null,
    documentNumber,
    firstName,
    context = {},
    data = {},
}) {
    const auth = await authenticateSaludtools(appointmentId, { context, data });
    if (!auth.ok) {
        return {
            ok: false,
            code: auth.code,
            authError: auth.error,
            skipped: auth.skipped,
        };
    }

    const url = saludtoolsSyncUrl();
    const payload = {
        eventType: "PATIENT",
        actionType: "SEARCH",
        body: {
            firstName: firstName || "",
            documentNumber: String(documentNumber),
            pageable: { page: 0, size: 20 },
        },
    };

    await logSaludtools(appointmentId, "PATIENT_SEARCH_REQUEST", {
        url,
        payload,
    });

    const res = await enqueueSaludtoolsRequest(() =>
        fetch(url, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${auth.token}`,
            },
            body: JSON.stringify(payload),
        }),
    );

    const raw = await res.text().catch(() => "");
    let json = null;
    try {
        json = raw ? JSON.parse(raw) : null;
    } catch {}

    await logSaludtools(appointmentId, "PATIENT_SEARCH_RESPONSE", {
        status: res.status,
        ok: res.ok,
        raw: raw?.slice(0, 1800),
        parsed: json,
    });

    if (!res.ok)
        return { ok: false, status: res.status, raw, error: json || raw };

    const items = extractPatientItems(json);
    const exists = items.length > 0;
    const active = exists ? isPatientActiveFromItem(items[0]) : false;

    return { ok: true, exists, active, items, data: json };
}

// ====== SALUDTOOLS: PATIENT CREATE ======
async function saludtoolsCreatePatient({
    appointmentId = null,
    patientBody,
    context = {},
    data = {},
}) {
    const auth = await authenticateSaludtools(appointmentId, { context, data });
    if (!auth.ok) {
        return {
            ok: false,
            code: auth.code,
            authError: auth.error,
            skipped: auth.skipped,
        };
    }

    const url = saludtoolsSyncUrl();
    const payload = {
        eventType: "PATIENT",
        actionType: "CREATE",
        body: patientBody,
    };

    await logSaludtools(appointmentId, "PATIENT_CREATE_REQUEST", {
        url,
        payload,
    });

    const res = await enqueueSaludtoolsRequest(() =>
        fetch(url, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${auth.token}`,
            },
            body: JSON.stringify(payload),
        }),
    );

    const raw = await res.text().catch(() => "");
    let json = null;
    try {
        json = raw ? JSON.parse(raw) : null;
    } catch {}

    await logSaludtools(appointmentId, "PATIENT_CREATE_RESPONSE", {
        status: res.status,
        ok: res.ok,
        raw: raw?.slice(0, 1800),
        parsed: json,
    });

    if (!res.ok)
        return { ok: false, status: res.status, raw, error: json || raw };
    return { ok: true, status: res.status, data: json ?? raw };
}

// ====== SALUDTOOLS: APPOINTMENT CREATE ======
async function saludtoolsCreateAppointment({
    appointmentId = null,
    patientDocumentType,
    patientDocumentNumber,
    startAppointmentYmd,
    startAppointmentHm,
    appointmentType,
    comment,
    context = {},
    data = {},
}) {
    const auth = await authenticateSaludtools(appointmentId, { context, data });
    if (!auth.ok) {
        return {
            ok: false,
            code: auth.code,
            authError: auth.error,
            skipped: auth.skipped,
        };
    }

    const url = saludtoolsSyncUrl();

    const startStr = `${startAppointmentYmd} ${startAppointmentHm}`;
    const end = addMinutesToYmdHm(
        startAppointmentYmd,
        startAppointmentHm,
        APPOINTMENT_DURATION_MIN,
    );
    const endStr = `${end.ymd} ${end.hm}`;

    const payload = {
        eventType: "APPOINTMENT",
        actionType: "CREATE",
        body: {
            startAppointment: startStr,
            endAppointment: endStr,
            patientDocumentType: Number(patientDocumentType),
            patientDocumentNumber: String(patientDocumentNumber),
            doctorDocumentType: DOCTOR_DOCUMENT_TYPE,
            doctorDocumentNumber: String(DOCTOR_DOCUMENT_NUMBER),
            modality: APPOINTMENT_MODALITY,
            stateAppointment: APPOINTMENT_STATE,
            appointmentType: appointmentType || APPOINTMENT_TYPE_DEFAULT,
            clinic: CLINIC_ID,
            comment: comment || "",
        },
    };

    await logSaludtools(appointmentId, "APPOINTMENT_CREATE_REQUEST", {
        url,
        payload,
        doctorDocumentNumber: DOCTOR_DOCUMENT_NUMBER,
        clinic: CLINIC_ID,
    });

    const res = await enqueueSaludtoolsRequest(() =>
        fetch(url, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${auth.token}`,
            },
            body: JSON.stringify(payload),
        }),
    );

    const raw = await res.text().catch(() => "");
    let json = null;
    try {
        json = raw ? JSON.parse(raw) : null;
    } catch {}

    await logSaludtools(appointmentId, "APPOINTMENT_CREATE_RESPONSE", {
        status: res.status,
        ok: res.ok,
        raw: raw?.slice(0, 1800),
        parsed: json,
    });

    if (!res.ok)
        return { ok: false, status: res.status, raw, error: json || raw };
    return { ok: true, status: res.status, data: json ?? raw };
}

// ====== UI: horarios ======
function buildTimeResponse(data) {
    const slots = getTimeSlots(data.page);
    let response = "Horas disponibles:\n\n";
    slots.forEach((h, i) => {
        response += `${i + 1}️⃣ ${h}\n`;
    });
    if (getTimeSlots(data.page + 1).length) response += "\n7️⃣ Más horarios";
    response += "\n\n0️⃣ Volver al menú";
    return { response, nextState: "AGENDAR", data };
}

// ====== MAIN STATE ======
export default async function agendarState(msg, data, context = {}) {
    const phone = context.from || "UNKNOWN";

    if (!data.step) {
        data.step = "ASK_NAME";
        return {
            response:
                "Vamos a iniciar el agendamiento.\n\n¿Cuál es tu nombre completo?",
            nextState: "AGENDAR",
            data,
        };
    }

    switch (data.step) {
        case "ASK_NAME": {
            if (!msg || msg.trim().length < 3) {
                return {
                    response: "Por favor ingresa tu nombre completo.",
                    nextState: "AGENDAR",
                    data,
                };
            }
            data.fullName = msg.trim();
            data.firstName = data.fullName.split(" ")[0];

            // ✅ Guardar nombre en BD para evitar INSERT con NULL en pacientes nuevos
            try {
                await upsertPatientName(phone, data.fullName);
            } catch {
                // No bloqueamos la UX si falla el guardado del nombre
            }

            data.step = "ASK_DOC_TYPE";
            return {
                response:
                    `Gracias, ${data.firstName}.\n\n` +
                    "Para crear tu cita necesito tu tipo de documento:\n\n" +
                    "1️⃣ CC\n" +
                    "2️⃣ CE\n\n" +
                    "0️⃣ Volver al menú",
                nextState: "AGENDAR",
                data,
            };
        }

        case "ASK_DOC_TYPE": {
            if (msg === "0") return returnToMenu();

            const t = normalizeDocType(msg);
            if (!t) {
                return {
                    response:
                        "Selecciona una opción válida:\n\n" +
                        "1️⃣ CC\n" +
                        "2️⃣ CE\n\n" +
                        "0️⃣ Volver al menú",
                    nextState: "AGENDAR",
                    data,
                };
            }

            data.patientDocumentType = t;
            data.step = "ASK_DOC_NUMBER";
            return {
                response: "Escribe tu número de documento (solo números):",
                nextState: "AGENDAR",
                data,
            };
        }

        case "ASK_DOC_NUMBER": {
            if (msg === "0") return returnToMenu();

            const doc = String(msg || "").trim();
            if (!/^\d{5,20}$/.test(doc)) {
                return {
                    response:
                        "Número inválido. Por favor escribe solo números (mínimo 5 dígitos):",
                    nextState: "AGENDAR",
                    data,
                };
            }

            data.patientDocumentNumber = doc;

            // registro técnico para logs del check
            if (!data.patientCheckId) {
                data.patientCheckId = await createProposedAppointment({
                    phone,
                    fullName: data.fullName,
                    date: "N/A",
                    time: "N/A",
                    attentionType: "PATIENT_CHECK",
                    status: "PATIENT_CHECK",
                });
            }
            const checkId = data.patientCheckId;

            await logAppointmentMessage(
                checkId,
                "[DEBUG] Check paciente (inicio)",
            );
            await logAppointmentMessage(
                checkId,
                `Documento tipo: ${data.patientDocumentType}`,
            );
            await logAppointmentMessage(
                checkId,
                `Documento número: ${data.patientDocumentNumber}`,
            );

            const fn =
                String(data.fullName || "")
                    .trim()
                    .split(/\s+/)[0] || "";
            const search = await saludtoolsSearchPatient({
                appointmentId: checkId,
                documentNumber: data.patientDocumentNumber,
                firstName: fn,
                context,
                data,
            });

            // ✅ Si AUTH bloqueado/429: NO paramos el flujo. Diferimos verificación.
            if (
                !search.ok &&
                (search.status === 429 ||
                    search.code === 429 ||
                    search.authError === "AUTH_BLOCKED")
            ) {
                data.deferPatientVerification = true;
                data.step = "FILTRO_COLUMNA";

                return {
                    response:
                        "Gracias. En este momento el sistema está con alta demanda para validar tu documento.\n\n" +
                        "Podemos continuar con el agendamiento y la validación/registro se hará antes de confirmar la cita.\n\n" +
                        "¿Tu consulta está relacionada con dolor lumbar, cervical o problemas de columna?\n\n" +
                        "1️⃣ Sí\n" +
                        "2️⃣ No\n\n" +
                        "0️⃣ Volver al menú",
                    nextState: "AGENDAR",
                    data,
                };
            }

            // Si falló por otra razón, también diferimos (no bloqueamos la UX)
            if (!search.ok) {
                data.deferPatientVerification = true;
                await logAppointmentMessage(
                    checkId,
                    `PATIENT_SEARCH falló: ${String(search.error || search.raw || "").slice(0, 400)}`,
                );
                data.step = "FILTRO_COLUMNA";
                return {
                    response:
                        "Gracias. Continuemos con tu solicitud.\n\n" +
                        "¿Tu consulta está relacionada con dolor lumbar, cervical o problemas de columna?\n\n" +
                        "1️⃣ Sí\n" +
                        "2️⃣ No\n\n" +
                        "0️⃣ Volver al menú",
                    nextState: "AGENDAR",
                    data,
                };
            }

            // Existe y activo -> seguir
            if (search.exists && search.active) {
                data.patientStatus = "ACTIVE";
                data.deferPatientVerification = false;
                await logAppointmentMessage(
                    checkId,
                    "Paciente encontrado y activo (OK)",
                );

                data.step = "FILTRO_COLUMNA";
                return {
                    response:
                        "Perfecto, ya encontré tu registro.\n\n" +
                        "¿Tu consulta está relacionada con dolor lumbar, cervical o problemas de columna?\n\n" +
                        "1️⃣ Sí\n" +
                        "2️⃣ No\n\n" +
                        "0️⃣ Volver al menú",
                    nextState: "AGENDAR",
                    data,
                };
            }

            // No existe o no activo -> pedir datos y registrar
            data.patientStatus = search.exists
                ? "INACTIVE_OR_UNKNOWN"
                : "NOT_FOUND";
            const parts = splitName(data.fullName || "");
            data.regPatient = {
                firstName: parts.firstName || "",
                secondName: parts.secondName || "",
                firstLastName: parts.firstLastName || "",
                secondLastName: parts.secondLastName || "",
                birthDate: "",
                gender: null,
                email: "",
                eps: "",
                habeasData: false,
            };

            data.step = "REG_CONFIRM_NAMES";
            return {
                response:
                    "No encontré tu registro activo en SaludTools. Vamos a registrarte antes de agendar.\n\n" +
                    `Tengo estos datos de tu nombre:\n` +
                    `• Primer nombre: ${data.regPatient.firstName || "(vacío)"}\n` +
                    `• Segundo nombre: ${data.regPatient.secondName || "(vacío)"}\n` +
                    `• Primer apellido: ${data.regPatient.firstLastName || "(vacío)"}\n` +
                    `• Segundo apellido: ${data.regPatient.secondLastName || "(vacío)"}\n\n` +
                    "¿Están correctos?\n\n" +
                    "1️⃣ Sí\n" +
                    "2️⃣ No, quiero editarlos\n\n" +
                    "0️⃣ Volver al menú",
                nextState: "AGENDAR",
                data,
            };
        }

        // ===== Registro de Paciente =====
        case "REG_CONFIRM_NAMES": {
            if (msg === "0") return returnToMenu();

            if (msg === "1") {
                data.step = "REG_BIRTHDATE";
                return {
                    response:
                        "Fecha de nacimiento (YYYY-MM-DD). Ej: 1967-12-05",
                    nextState: "AGENDAR",
                    data,
                };
            }

            if (msg === "2") {
                data.step = "REG_FIRSTNAME";
                return {
                    response: "Primer nombre:",
                    nextState: "AGENDAR",
                    data,
                };
            }

            return {
                response: "Responde 1, 2 o 0.",
                nextState: "AGENDAR",
                data,
            };
        }

        case "REG_FIRSTNAME": {
            if (msg === "0") return returnToMenu();
            const v = String(msg || "").trim();
            if (v.length < 2)
                return {
                    response: "Primer nombre inválido. Intenta de nuevo:",
                    nextState: "AGENDAR",
                    data,
                };
            data.regPatient.firstName = v;
            data.step = "REG_SECONDNAME";
            return {
                response: "Segundo nombre (si no tienes, escribe 0):",
                nextState: "AGENDAR",
                data,
            };
        }

        case "REG_SECONDNAME": {
            if (msg === "0") data.regPatient.secondName = "";
            else data.regPatient.secondName = String(msg || "").trim();
            data.step = "REG_FIRSTLASTNAME";
            return { response: "Primer apellido:", nextState: "AGENDAR", data };
        }

        case "REG_FIRSTLASTNAME": {
            const v = String(msg || "").trim();
            if (v.length < 2)
                return {
                    response: "Apellido inválido. Intenta de nuevo:",
                    nextState: "AGENDAR",
                    data,
                };
            data.regPatient.firstLastName = v;
            data.step = "REG_SECONDLASTNAME";
            return {
                response: "Segundo apellido (si no tienes, escribe 0):",
                nextState: "AGENDAR",
                data,
            };
        }

        case "REG_SECONDLASTNAME": {
            if (msg === "0") data.regPatient.secondLastName = "";
            else data.regPatient.secondLastName = String(msg || "").trim();
            data.step = "REG_BIRTHDATE";
            return {
                response: "Fecha de nacimiento (YYYY-MM-DD). Ej: 1967-12-05",
                nextState: "AGENDAR",
                data,
            };
        }

        case "REG_BIRTHDATE": {
            if (msg === "0") return returnToMenu();
            const v = String(msg || "").trim();
            if (!isValidBirthDateYmd(v)) {
                return {
                    response: "Fecha inválida. Usa YYYY-MM-DD. Ej: 1967-12-05",
                    nextState: "AGENDAR",
                    data,
                };
            }
            data.regPatient.birthDate = v;
            data.step = "REG_GENDER";
            return {
                response:
                    "Género:\n\n" +
                    "1️⃣ Masculino\n" +
                    "2️⃣ Femenino\n\n" +
                    "0️⃣ Volver al menú",
                nextState: "AGENDAR",
                data,
            };
        }

        case "REG_GENDER": {
            if (msg === "0") return returnToMenu();
            if (msg !== "1" && msg !== "2") {
                return {
                    response: "Elige 1 o 2, o 0 para volver al menú.",
                    nextState: "AGENDAR",
                    data,
                };
            }
            data.regPatient.gender = Number(msg);
            data.step = "REG_EMAIL";
            return {
                response: "Correo electrónico (si no tienes, escribe 0):",
                nextState: "AGENDAR",
                data,
            };
        }

        case "REG_EMAIL": {
            if (msg === "0") data.regPatient.email = "";
            else {
                const em = normalizeEmail(msg);
                if (em === null)
                    return {
                        response:
                            "Correo inválido. Intenta de nuevo o escribe 0:",
                        nextState: "AGENDAR",
                        data,
                    };
                data.regPatient.email = em;
            }
            data.step = "REG_EPS";
            return {
                response:
                    "EPS (número). Si no aplica o no sabes, escribe 0. Ej: 3",
                nextState: "AGENDAR",
                data,
            };
        }

        case "REG_EPS": {
            const v = String(msg || "").trim();
            if (v === "0") data.regPatient.eps = "";
            else if (!/^\d+$/.test(v))
                return {
                    response: "EPS inválida. Escribe un número o 0:",
                    nextState: "AGENDAR",
                    data,
                };
            else data.regPatient.eps = v;

            data.step = "REG_HABEAS";
            return {
                response:
                    "Autorización de tratamiento de datos (Habeas Data):\n\n" +
                    "1️⃣ Sí, autorizo\n" +
                    "2️⃣ No autorizo\n\n" +
                    "0️⃣ Volver al menú",
                nextState: "AGENDAR",
                data,
            };
        }

        case "REG_HABEAS": {
            if (msg === "0") return returnToMenu();
            if (msg !== "1" && msg !== "2")
                return {
                    response: "Responde 1 o 2, o 0.",
                    nextState: "AGENDAR",
                    data,
                };
            data.regPatient.habeasData = msg === "1";

            // Si auth está bloqueado, no podemos registrar ahora: seguimos y lo dejamos a secretaria.
            const now = Date.now();
            if (
                data.saludtoolsAuthBlockedUntil &&
                now < data.saludtoolsAuthBlockedUntil
            ) {
                data.deferPatientVerification = true;
                data.step = "FILTRO_COLUMNA";
                return {
                    response:
                        "Gracias. En este momento el sistema está con alta demanda para completar el registro.\n\n" +
                        "Continuemos con el agendamiento y la secretaria confirmará tu registro.\n\n" +
                        "¿Tu consulta está relacionada con dolor lumbar, cervical o problemas de columna?\n\n" +
                        "1️⃣ Sí\n" +
                        "2️⃣ No\n\n" +
                        "0️⃣ Volver al menú",
                    nextState: "AGENDAR",
                    data,
                };
            }

            // Crear paciente
            if (!data.patientCheckId) {
                data.patientCheckId = await createProposedAppointment({
                    phone,
                    fullName: data.fullName,
                    date: "N/A",
                    time: "N/A",
                    attentionType: "PATIENT_CHECK",
                    status: "PATIENT_CHECK",
                });
            }
            const checkId = data.patientCheckId;

            const patientBodyRaw = {
                firstName: data.regPatient.firstName,
                secondName: data.regPatient.secondName || "",
                firstLastName: data.regPatient.firstLastName,
                secondLastName: data.regPatient.secondLastName || "",
                birthDate: data.regPatient.birthDate,
                gender: Number(data.regPatient.gender),
                documentType: Number(data.patientDocumentType),
                documentNumber: String(data.patientDocumentNumber),
                phone: parsePhoneE164ToDigits(phone),
                cellPhone: parsePhoneE164ToDigits(phone),
                email: data.regPatient.email || "",
                eps: data.regPatient.eps ? Number(data.regPatient.eps) : 0,
                habeasData: Boolean(data.regPatient.habeasData),
            };

            const checked = validateAndNormalizePatientBody(patientBodyRaw);
            if (!checked.ok) {
                data.step = checked.step;
                return {
                    response: checked.message,
                    nextState: "AGENDAR",
                    data,
                };
            }

            const patientBody = checked.body;

            await logAppointmentMessage(
                checkId,
                "[DEBUG] Registro paciente: intentando CREATE",
            );
            const created = await saludtoolsCreatePatient({
                appointmentId: checkId,
                patientBody,
                context,
                data,
            });

            if (!created.ok) {
                // si fue 429, bloqueamos y seguimos el agendamiento sin SaludTools
                if (
                    created.status === 429 ||
                    created.code === 429 ||
                    created.authError === "AUTH_BLOCKED"
                ) {
                    data.deferPatientVerification = true;
                    data.step = "FILTRO_COLUMNA";
                    return {
                        response:
                            "Estoy teniendo alta demanda para completar el registro en este momento.\n\n" +
                            "Continuemos con el agendamiento y la secretaria confirmará el registro y la cita.\n\n" +
                            "¿Tu consulta está relacionada con dolor lumbar, cervical o problemas de columna?\n\n" +
                            "1️⃣ Sí\n" +
                            "2️⃣ No\n\n" +
                            "0️⃣ Volver al menú",
                        nextState: "AGENDAR",
                        data,
                    };
                }

                return {
                    response:
                        "No pude registrar tu paciente en este momento.\n\n" +
                        "Responde:\n" +
                        "1️⃣ Reintentar registro\n" +
                        "0️⃣ Volver al menú",
                    nextState: "AGENDAR",
                    data: { ...data, step: "REG_RETRY" },
                };
            }

            await logAppointmentMessage(
                checkId,
                "Paciente creado OK. Continuar agendamiento.",
            );
            data.patientStatus = "ACTIVE";
            data.deferPatientVerification = false;
            data.step = "FILTRO_COLUMNA";

            return {
                response:
                    "Listo ✅ Ya quedaste registrado.\n\n" +
                    "Ahora sí, continuemos con el agendamiento.\n\n" +
                    "¿Tu consulta está relacionada con dolor lumbar, cervical o problemas de columna?\n\n" +
                    "1️⃣ Sí\n" +
                    "2️⃣ No\n\n" +
                    "0️⃣ Volver al menú",
                nextState: "AGENDAR",
                data,
            };
        }

        case "REG_RETRY": {
            if (msg === "0") return returnToMenu();
            if (msg === "1") {
                data.step = "REG_HABEAS";
                return {
                    response:
                        "Autorización de tratamiento de datos (Habeas Data):\n\n" +
                        "1️⃣ Sí, autorizo\n" +
                        "2️⃣ No autorizo\n\n" +
                        "0️⃣ Volver al menú",
                    nextState: "AGENDAR",
                    data,
                };
            }
            return { response: "Responde 1 o 0.", nextState: "AGENDAR", data };
        }

        // ===== Agendamiento normal =====
        case "FILTRO_COLUMNA": {
            if (msg === "0") return returnToMenu();

            if (msg === "1") {
                data.step = "ASK_DATE";
                return {
                    response:
                        "¿Para qué fecha deseas agendar la cita?\n(DD/MM)",
                    nextState: "AGENDAR",
                    data,
                };
            }

            if (msg === "2") {
                data.step = "FILTRO_CONFIRM";
                return {
                    response:
                        "El Dr. se especializa principalmente en problemas de columna.\n\n" +
                        "¿Deseas continuar con el agendamiento?\n\n" +
                        "1️⃣ Sí\n" +
                        "0️⃣ Volver al menú",
                    nextState: "AGENDAR",
                    data,
                };
            }

            return {
                response: "Responde 1 o 2, o 0 para volver al menú.",
                nextState: "AGENDAR",
                data,
            };
        }

        case "FILTRO_CONFIRM": {
            if (msg === "0") return returnToMenu();
            if (msg === "1") {
                data.step = "ASK_DATE";
                return {
                    response:
                        "¿Para qué fecha deseas agendar la cita?\n(DD/MM)",
                    nextState: "AGENDAR",
                    data,
                };
            }
            return {
                response: "Responde 1 para continuar o 0 para volver al menú.",
                nextState: "AGENDAR",
                data,
            };
        }

        case "ASK_DATE": {
            if (!isValidDateDDMM(msg)) {
                return {
                    response:
                        "Fecha inválida. Debe ser DD/MM y una fecha futura.",
                    nextState: "AGENDAR",
                    data,
                };
            }
            data.date = msg;
            data.page = 0;
            data.step = "ASK_TIME";
            return buildTimeResponse(data);
        }

        case "ASK_TIME": {
            if (msg === "0") return returnToMenu();

            if (msg === "7") {
                data.page++;
                return buildTimeResponse(data);
            }

            const index = parseInt(msg, 10) - 1;
            const slots = getTimeSlots(data.page);
            const hour = slots[index];
            if (!hour)
                return {
                    response: "Opción inválida. Elige un número del listado.",
                    nextState: "AGENDAR",
                    data,
                };

            data.time = hour;
            data.step = "ASK_TYPE";
            return {
                response:
                    "¿Qué tipo de atención deseas?\n\n" +
                    "1️⃣ Consulta particular\n" +
                    "2️⃣ Consulta con póliza / prepagada\n\n" +
                    "0️⃣ Volver al menú",
                nextState: "AGENDAR",
                data,
            };
        }

        case "ASK_TYPE": {
            if (msg === "0") return returnToMenu();

            if (msg === "1") data.attentionType = "Consulta particular";
            else if (msg === "2")
                data.attentionType = "Consulta con póliza/prepagada";
            else {
                return {
                    response:
                        "Selecciona una opción válida:\n\n" +
                        "1️⃣ Consulta particular\n" +
                        "2️⃣ Consulta con póliza / prepagada\n\n" +
                        "0️⃣ Volver al menú",
                    nextState: "AGENDAR",
                    data,
                };
            }

            data.step = "SHOW_COST_INFO";
            return {
                response:
                    "La consulta particular tiene un valor de $400.000\n\n" +
                    "Si son controles continuos el valor puede ser menor (previa validación).\n\n" +
                    "Los descuentos son autorizados directamente por el Dr.\n\n" +
                    "1️⃣ Continuar\n" +
                    "0️⃣ Volver al menú",
                nextState: "AGENDAR",
                data,
            };
        }

        case "SHOW_COST_INFO": {
            if (msg === "0") return returnToMenu();
            if (msg !== "1")
                return {
                    response:
                        "Responde 1 para continuar o 0 para volver al menú.",
                    nextState: "AGENDAR",
                    data,
                };

            const appointmentId = await createProposedAppointment({
                phone,
                fullName: data.fullName,
                date: data.date,
                time: data.time,
                attentionType: data.attentionType,
                status: "PROPOSED",
            });
            data.appointmentId = appointmentId;

            await logAppointmentMessage(
                appointmentId,
                "Inicio de agendamiento por bot",
            );
            await logAppointmentMessage(
                appointmentId,
                `Paciente: ${data.fullName}`,
            );
            await logAppointmentMessage(appointmentId, `Teléfono: ${phone}`);
            await logAppointmentMessage(
                appointmentId,
                `Documento tipo: ${data.patientDocumentType}`,
            );
            await logAppointmentMessage(
                appointmentId,
                `Documento número: ${data.patientDocumentNumber}`,
            );
            await logAppointmentMessage(
                appointmentId,
                `Fecha: ${data.date} | Hora: ${data.time}`,
            );
            await logAppointmentMessage(
                appointmentId,
                `Tipo de atención: ${data.attentionType}`,
            );

            // ✅ Circuit breaker: si auth está bloqueado, NO intentamos SaludTools.
            const now = Date.now();
            if (
                data.saludtoolsAuthBlockedUntil &&
                now < data.saludtoolsAuthBlockedUntil
            ) {
                await logAppointmentMessage(
                    appointmentId,
                    `⚠️ SaludTools: AUTH bloqueado por 429 hasta ${new Date(data.saludtoolsAuthBlockedUntil).toISOString()}`,
                );

                await notifySecretaryNewAppointment({
                    fullName: data.fullName,
                    phone,
                    date: data.date,
                    time: data.time,
                    attentionType: `${data.attentionType} | SaludTools: PENDIENTE (rate limit 429)`,
                    redirectUrl: "N/A",
                });

                data.step = "POST_CREATED";
                return {
                    response:
                        `Perfecto ${data.firstName}.\n\n` +
                        `Tipo: *${data.attentionType}*\n\n` +
                        "Tu solicitud quedó registrada.\n\n" +
                        "⚠️ En este momento el sistema está con alta demanda, así que la secretaria confirmará y registrará la cita.\n\n" +
                        "Responde:\n" +
                        "1️⃣ Ya terminé\n" +
                        "2️⃣ Volver al menú",
                    nextState: "AGENDAR",
                    data,
                };
            }

            // Intentar crear cita en SaludTools
            const ymd = ddmmToYmd(data.date);

            const st = await saludtoolsCreateAppointment({
                appointmentId,
                patientDocumentType: Number(data.patientDocumentType),
                patientDocumentNumber: String(data.patientDocumentNumber),
                startAppointmentYmd: ymd,
                startAppointmentHm: data.time,
                appointmentType: APPOINTMENT_TYPE_DEFAULT,
                comment: `Creada por chatbot. Paciente: ${data.fullName}. Tel: ${phone}`,
                context,
                data,
            });

            if (
                !st.ok &&
                (st.status === 429 ||
                    st.code === 429 ||
                    st.authError === "AUTH_BLOCKED")
            ) {
                // si se volvió a bloquear, lo dejamos a secretaria
                await notifySecretaryNewAppointment({
                    fullName: data.fullName,
                    phone,
                    date: data.date,
                    time: data.time,
                    attentionType: `${data.attentionType} | SaludTools: PENDIENTE (rate limit 429)`,
                    redirectUrl: "N/A",
                });

                data.step = "POST_CREATED";
                return {
                    response:
                        `Perfecto ${data.firstName}.\n\n` +
                        `Tipo: *${data.attentionType}*\n\n` +
                        "Tu solicitud quedó registrada.\n\n" +
                        "⚠️ En este momento el sistema está con alta demanda, así que la secretaria confirmará y registrará la cita.\n\n" +
                        "Responde:\n" +
                        "1️⃣ Ya terminé\n" +
                        "2️⃣ Volver al menú",
                    nextState: "AGENDAR",
                    data,
                };
            }

            // Notificar secretaria con resultado
            const saludtoolsNote =
                st.ok === true
                    ? "SaludTools: cita creada ✅"
                    : "SaludTools: revisar creación ⚠️";

            await notifySecretaryNewAppointment({
                fullName: data.fullName,
                phone,
                date: data.date,
                time: data.time,
                attentionType: `${data.attentionType} | ${saludtoolsNote}`,
                redirectUrl: "N/A",
            });

            data.step = "POST_CREATED";
            return {
                response:
                    `Perfecto ${data.firstName}.\n\n` +
                    `Tipo: *${data.attentionType}*\n\n` +
                    "Tu solicitud quedó registrada.\n\n" +
                    "Responde:\n" +
                    "1️⃣ Ya terminé\n" +
                    "2️⃣ Volver al menú",
                nextState: "AGENDAR",
                data,
            };
        }

        case "POST_CREATED": {
            if (msg === "1") {
                await confirmAppointment(data.appointmentId);
                return {
                    response:
                        `Listo ${data.firstName}.\n\n` +
                        "La secretaria hará seguimiento si es necesario.",
                    nextState: "MENU",
                    data: { renderMenu: true },
                };
            }

            if (msg === "2") return returnToMenu();
            return { response: "Responde 1 o 2.", nextState: "AGENDAR", data };
        }

        default:
            return {
                response:
                    "Vamos a iniciar el agendamiento.\n\n¿Cuál es tu nombre completo?",
                nextState: "AGENDAR",
                data: { step: "ASK_NAME" },
            };
    }
}
