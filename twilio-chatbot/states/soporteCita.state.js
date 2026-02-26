/**
 * SOPORTE DE CITA (REAGENDAR / CANCELAR)
 *
 * Implementa endpoints según la colección Postman (IntegracionSaludtools):
 * - Sync: POST {{hostlocal}}integration/sync/event/v1/
 *   - APPOINTMENT SEARCH
 *   - APPOINTMENT UPDATE (reagendar)
 *   - APPOINTMENT DELETE (cancelar)
 *
 * Referencia Postman:
 * - appointment update: eventType=APPOINTMENT, actionType=UPDATE  (incluye id, startAppointment, endAppointment, ...)
 * - appointment delete: eventType=APPOINTMENT, actionType=DELETE  (incluye id)
 */

// ====== CONFIG (ENV) ======
const SALUDTOOLS_HOST =
    process.env.SALUDTOOLS_HOST || "https://saludtools.carecloud.com.co/";
const SALUDTOOLS_APIKEY = process.env.SALUDTOOLS_APIKEY || "";
const SALUDTOOLS_APISECRET = process.env.SALUDTOOLS_APISECRET || "";

const DOCTOR_DOCUMENT_TYPE = Number(
    process.env.SALUDTOOLS_DOCTOR_DOCUMENT_TYPE || 1,
);
const DOCTOR_DOCUMENT_NUMBER =
    process.env.SALUDTOOLS_DOCTOR_DOCUMENT_NUMBER || "72134079";
const CLINIC_ID = Number(process.env.SALUDTOOLS_CLINIC_ID || 18569);

const APPOINTMENT_DURATION_MIN = Number(
    process.env.SALUDTOOLS_APPOINTMENT_DURATION_MIN || 30,
);
const APPOINTMENT_MODALITY =
    process.env.SALUDTOOLS_APPOINTMENT_MODALITY || "CONVENTIONAL";
const APPOINTMENT_STATE = process.env.SALUDTOOLS_APPOINTMENT_STATE || "PENDING";
const APPOINTMENT_TYPE_DEFAULT =
    process.env.SALUDTOOLS_APPOINTMENT_TYPE || "Consulta";

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

function logDebug(label, payload) {
    if (!SALUDTOOLS_DEBUG) return;
    console.log(`[SALUDTOOLS][SOPORTE_CITA] ${label} | ${safeJson(payload)}`);
}

function saludtoolsSyncUrl() {
    return new URL("integration/sync/event/v1/", SALUDTOOLS_HOST).toString();
}

function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
}

// ====== Token cache (memory) ======
let cachedToken = null;
let cachedTokenExp = 0; // epoch ms
let authInFlight = null;

async function authenticateSaludtools(meta = {}) {
    const { data = {} } = meta;

    if (!SALUDTOOLS_APIKEY || !SALUDTOOLS_APISECRET) {
        logDebug("AUTH_MISSING_CREDENTIALS", {
            hasKey: !!SALUDTOOLS_APIKEY,
            hasSecret: !!SALUDTOOLS_APISECRET,
        });
        return { ok: false, token: null, error: "Missing credentials" };
    }

    const now = Date.now();

    // Token en data (por conversación)
    if (data.saludtoolsToken && data.saludtoolsTokenExp) {
        if (now < data.saludtoolsTokenExp - 30_000) {
            return { ok: true, token: data.saludtoolsToken };
        }
    }

    // Cache proceso
    if (cachedToken && now < cachedTokenExp - 30_000) {
        data.saludtoolsToken = cachedToken;
        data.saludtoolsTokenExp = cachedTokenExp;
        return { ok: true, token: cachedToken };
    }

    // Lock inflight
    if (authInFlight) {
        try {
            const token = await authInFlight;
            return { ok: true, token };
        } catch {
            // sigue
        }
    }

    const url = new URL(
        "integration/authenticate/apikey/v1/",
        SALUDTOOLS_HOST,
    ).toString();

    const doAuthOnce = async () => {
        logDebug("AUTH_REQUEST", { url });

        const res = await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                key: SALUDTOOLS_APIKEY,
                secret: SALUDTOOLS_APISECRET,
            }),
        });

        const raw = await res.text().catch(() => "");
        let json = null;
        try {
            json = raw ? JSON.parse(raw) : null;
        } catch {}

        logDebug("AUTH_RESPONSE", { status: res.status, ok: res.ok, raw });

        if (!res.ok) {
            return { ok: false, code: res.status, error: json || raw };
        }

        const token = json?.token || json?.body?.token || json?.access_token;
        if (!token) {
            return { ok: false, code: res.status, error: "Token not found" };
        }

        // Exp por defecto: 50 min
        const expMs = now + 50 * 60 * 1000;
        cachedToken = token;
        cachedTokenExp = expMs;
        data.saludtoolsToken = token;
        data.saludtoolsTokenExp = expMs;

        return { ok: true, token };
    };

    // Retry básico si hay 429
    authInFlight = (async () => {
        const r1 = await doAuthOnce();
        if (r1.ok) return r1.token;

        if (r1.code === 429) {
            await sleep(900);
            const r2 = await doAuthOnce();
            if (r2.ok) return r2.token;
            throw new Error("AUTH_FAILED_429");
        }

        throw new Error("AUTH_FAILED");
    })();

    try {
        const token = await authInFlight;
        return { ok: true, token };
    } catch (e) {
        return { ok: false, token: null, error: String(e?.message || e) };
    } finally {
        authInFlight = null;
    }
}

function addMinutesToYmdHm(ymd, hm, minutes) {
    const [y, m, d] = ymd.split("-").map((n) => Number(n));
    const [hh, mm] = hm.split(":").map((n) => Number(n));
    const dt = new Date(Date.UTC(y, m - 1, d, hh, mm, 0));
    dt.setUTCMinutes(dt.getUTCMinutes() + Number(minutes || 0));

    const y2 = dt.getUTCFullYear();
    const m2 = String(dt.getUTCMonth() + 1).padStart(2, "0");
    const d2 = String(dt.getUTCDate()).padStart(2, "0");
    const hh2 = String(dt.getUTCHours()).padStart(2, "0");
    const mm2 = String(dt.getUTCMinutes()).padStart(2, "0");

    return { ymd: `${y2}-${m2}-${d2}`, hm: `${hh2}:${mm2}` };
}

function extractAppointmentItems(searchJson) {
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

function formatAppointmentLine(item, idx) {
    const id = item?.id ?? item?.appointmentId ?? item?.code ?? "";
    const start = item?.startAppointment || item?.start || item?.date || "";
    const end = item?.endAppointment || item?.end || "";
    const modality = item?.modality || item?.attentionModality || "";

    const startTxt = String(start).replace("T", " ").slice(0, 16);
    const endTxt = String(end).replace("T", " ").slice(0, 16);

    return `${idx + 1}️⃣ ID ${id} | ${startTxt}$${end ? " - " + endTxt : ""}$${modality ? " | " + modality : ""}`.replaceAll(
        "$",
        "",
    );
}

async function saludtoolsSearchAppointmentsByPatient({
    patientDocumentType,
    patientDocumentNumber,
    data,
}) {
    const auth = await authenticateSaludtools({ data });
    if (!auth.ok) return { ok: false, error: auth.error };

    const url = saludtoolsSyncUrl();
    const payload = {
        eventType: "APPOINTMENT",
        actionType: "SEARCH",
        body: {
            patientDocumentType: Number(patientDocumentType),
            patientDocumentNumber: String(patientDocumentNumber),
            pageable: { page: 0, size: 20 },
        },
    };

    logDebug("APPOINTMENT_SEARCH_REQUEST", { url, payload });

    const res = await fetch(url, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${auth.token}`,
        },
        body: JSON.stringify(payload),
    });

    const raw = await res.text().catch(() => "");
    let json = null;
    try {
        json = raw ? JSON.parse(raw) : null;
    } catch {}

    logDebug("APPOINTMENT_SEARCH_RESPONSE", {
        status: res.status,
        ok: res.ok,
        raw: raw?.slice(0, 1500),
        parsed: json,
    });

    if (!res.ok)
        return { ok: false, status: res.status, raw, error: json || raw };

    const items = extractAppointmentItems(json);
    return { ok: true, items, data: json };
}

async function saludtoolsUpdateAppointment({
    appointmentId,
    patientDocumentType,
    patientDocumentNumber,
    startAppointmentYmd,
    startAppointmentHm,
    appointmentType,
    comment,
    data,
}) {
    const auth = await authenticateSaludtools({ data });
    if (!auth.ok) return { ok: false, error: auth.error };

    const url = saludtoolsSyncUrl();

    const startStr = `${startAppointmentYmd} ${startAppointmentHm}`;
    const end = addMinutesToYmdHm(
        startAppointmentYmd,
        startAppointmentHm,
        APPOINTMENT_DURATION_MIN,
    );
    const endStr = `${end.ymd} ${end.hm}`;

    // Según Postman: APPOINTMENT UPDATE requiere al menos id/start/end y datos base.
    const payload = {
        eventType: "APPOINTMENT",
        actionType: "UPDATE",
        body: {
            id: String(appointmentId),
            startAppointment: startStr,
            endAppointment: endStr,
            patientDocumentType: Number(patientDocumentType),
            patientDocumentNumber: String(patientDocumentNumber),
            doctorDocumentType: DOCTOR_DOCUMENT_TYPE,
            doctorDocumentNumber: String(DOCTOR_DOCUMENT_NUMBER),
            modality: APPOINTMENT_MODALITY,
            stateAppointment: APPOINTMENT_STATE,
            notificationState: "ATTEND",
            appointmentType: appointmentType || APPOINTMENT_TYPE_DEFAULT,
            clinic: CLINIC_ID,
            comment: comment || "",
        },
    };

    logDebug("APPOINTMENT_UPDATE_REQUEST", { url, payload });

    const res = await fetch(url, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${auth.token}`,
        },
        body: JSON.stringify(payload),
    });

    const raw = await res.text().catch(() => "");
    let json = null;
    try {
        json = raw ? JSON.parse(raw) : null;
    } catch {}

    logDebug("APPOINTMENT_UPDATE_RESPONSE", {
        status: res.status,
        ok: res.ok,
        raw: raw?.slice(0, 1500),
        parsed: json,
    });

    if (!res.ok)
        return { ok: false, status: res.status, raw, error: json || raw };
    return { ok: true, status: res.status, data: json ?? raw };
}

async function saludtoolsDeleteAppointment({ appointmentId, data }) {
    const auth = await authenticateSaludtools({ data });
    if (!auth.ok) return { ok: false, error: auth.error };

    const url = saludtoolsSyncUrl();

    // Según Postman: APPOINTMENT DELETE incluye id
    const payload = {
        eventType: "APPOINTMENT",
        actionType: "DELETE",
        body: { id: String(appointmentId) },
    };

    logDebug("APPOINTMENT_DELETE_REQUEST", { url, payload });

    const res = await fetch(url, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${auth.token}`,
        },
        body: JSON.stringify(payload),
    });

    const raw = await res.text().catch(() => "");
    let json = null;
    try {
        json = raw ? JSON.parse(raw) : null;
    } catch {}

    logDebug("APPOINTMENT_DELETE_RESPONSE", {
        status: res.status,
        ok: res.ok,
        raw: raw?.slice(0, 1500),
        parsed: json,
    });

    if (!res.ok)
        return { ok: false, status: res.status, raw, error: json || raw };
    return { ok: true, status: res.status, data: json ?? raw };
}

function isBackToMenu(input) {
    return String(input || "").trim() === "0";
}

function normalizeYesNo(input) {
    const t = String(input || "")
        .trim()
        .toLowerCase();
    if (["si", "sí", "s", "1", "ok", "vale"].includes(t)) return "YES";
    if (["no", "n", "2", "cancelar"].includes(t)) return "NO";
    return "";
}

function isValidYmd(s) {
    return /^\d{4}-\d{2}-\d{2}$/.test(String(s || "").trim());
}

function isValidHm(s) {
    return /^([01]\d|2[0-3]):[0-5]\d$/.test(String(s || "").trim());
}

export default async function soporteCitaState(msg, data = {}, context = {}) {
    const { tipo, step } = data;
    const text = String(msg || "").trim();

    // Paso 0 (entry): si no hay step
    if (!step) {
        return {
            response:
                "Por favor escribe tu número de documento (sin puntos ni espacios):\n\n0️⃣ Volver al menú",
            nextState: "SOPORTE_CITA",
            data: { ...data, step: "ASK_DOCUMENT" },
        };
    }

    // Paso 1: pedir documento
    if (step === "ASK_DOCUMENT") {
        if (isBackToMenu(text)) {
            return {
                response: "Volviendo al menú principal.",
                nextState: "MENU",
                data: { renderMenu: true },
            };
        }

        const documento = text;
        if (!/^\d+$/.test(documento)) {
            return {
                response:
                    "El número de documento debe contener solo números. Intenta nuevamente:\n\n0️⃣ Volver al menú",
                nextState: "SOPORTE_CITA",
                data,
            };
        }

        return {
            response:
                "Gracias. Estamos validando tu información, por favor espera un momento…",
            nextState: "SOPORTE_CITA",
            data: {
                ...data,
                step: "PROCESS_SEARCH",
                documento,
            },
        };
    }

    // Paso 2: buscar citas
    if (step === "PROCESS_SEARCH") {
        try {
            const documento = data.documento;
            const patientDocumentType = Number(data.patientDocumentType || 1);

            const search = await saludtoolsSearchAppointmentsByPatient({
                patientDocumentType,
                patientDocumentNumber: documento,
                data,
            });

            if (!search.ok) {
                return {
                    response:
                        "No pudimos consultar tus citas en este momento.\n\nSi necesitas ayuda, escribe *SECRETARIA*.\n\n0️⃣ Volver al menú",
                    nextState: "SOPORTE_CITA",
                    data: { ...data, step: "ASK_DOCUMENT" },
                };
            }

            const items = (search.items || []).filter(Boolean);

            if (!items.length) {
                return {
                    response:
                        "No encontramos citas asociadas a ese documento.\n\nSi necesitas ayuda adicional, escribe *SECRETARIA* para comunicarte con nuestro equipo.",
                    nextState: "MENU",
                    data: { renderMenu: true },
                };
            }

            const lines = items
                .slice(0, 10)
                .map((it, idx) => formatAppointmentLine(it, idx));

            return {
                response:
                    "Encontramos estas citas asociadas a tu documento:\n\n" +
                    lines.join("\n") +
                    "\n\nEscribe el número de la cita que deseas " +
                    (tipo === "CANCELAR" ? "cancelar" : "reagendar") +
                    ".\n\n0️⃣ Volver al menú",
                nextState: "SOPORTE_CITA",
                data: {
                    ...data,
                    step: "SELECT_APPOINTMENT",
                    citas: items.slice(0, 10),
                },
            };
        } catch (error) {
            console.error("Error en soporteCitaState (PROCESS_SEARCH):", error);
            return {
                response:
                    "Ocurrió un error procesando tu solicitud.\n\nPor favor escribe *SECRETARIA* para que podamos ayudarte manualmente.",
                nextState: "MENU",
                data: { renderMenu: true },
            };
        }
    }

    // Paso 3: seleccionar cita
    if (step === "SELECT_APPOINTMENT") {
        if (isBackToMenu(text)) {
            return {
                response: "Volviendo al menú principal.",
                nextState: "MENU",
                data: { renderMenu: true },
            };
        }

        const idx = Number(text) - 1;
        const citas = Array.isArray(data.citas) ? data.citas : [];

        if (!Number.isFinite(idx) || idx < 0 || idx >= citas.length) {
            return {
                response:
                    "Opción inválida. Escribe el número de la cita que deseas gestionar.\n\n0️⃣ Volver al menú",
                nextState: "SOPORTE_CITA",
                data,
            };
        }

        const cita = citas[idx];
        const appointmentId = cita?.id ?? cita?.appointmentId ?? cita?.code;

        if (!appointmentId) {
            return {
                response:
                    "No pudimos identificar el ID de la cita seleccionada.\n\nEscribe *SECRETARIA* para ayudarte.",
                nextState: "MENU",
                data: { renderMenu: true },
            };
        }

        if (tipo === "CANCELAR") {
            return {
                response: `Vas a cancelar la cita ID ${appointmentId}.\n\nResponde SI para confirmar o NO para abortar.\n\n0️⃣ Volver al menú`,
                nextState: "SOPORTE_CITA",
                data: { ...data, step: "CONFIRM_CANCEL", appointmentId },
            };
        }

        // REAGENDAR
        return {
            response: `Vas a reagendar la cita ID ${appointmentId}.\n\nEscribe la nueva fecha en formato AAAA-MM-DD (ej: 2026-03-05).\n\n0️⃣ Volver al menú`,
            nextState: "SOPORTE_CITA",
            data: { ...data, step: "ASK_NEW_DATE", appointmentId },
        };
    }

    // CANCELAR: confirmación
    if (step === "CONFIRM_CANCEL") {
        if (isBackToMenu(text)) {
            return {
                response: "Volviendo al menú principal.",
                nextState: "MENU",
                data: { renderMenu: true },
            };
        }

        const yn = normalizeYesNo(text);
        if (!yn) {
            return {
                response:
                    "Por favor responde SI para confirmar o NO para abortar.\n\n0️⃣ Volver al menú",
                nextState: "SOPORTE_CITA",
                data,
            };
        }

        if (yn === "NO") {
            return {
                response:
                    "Listo, no realizamos cambios.\n\nVolviendo al menú principal.",
                nextState: "MENU",
                data: { renderMenu: true },
            };
        }

        try {
            const del = await saludtoolsDeleteAppointment({
                appointmentId: data.appointmentId,
                data,
            });

            if (!del.ok) {
                return {
                    response:
                        "No fue posible cancelar la cita en este momento.\n\nPor favor escribe *SECRETARIA* para ayudarte.",
                    nextState: "MENU",
                    data: { renderMenu: true },
                };
            }

            return {
                response:
                    "Tu cita fue cancelada correctamente.\n\nSi deseas agendar una nueva consulta, puedes hacerlo desde el menú principal.",
                nextState: "MENU",
                data: { renderMenu: true },
            };
        } catch (error) {
            console.error("Error en soporteCitaState (CONFIRM_CANCEL):", error);
            return {
                response:
                    "Ocurrió un error cancelando tu cita.\n\nPor favor escribe *SECRETARIA* para que podamos ayudarte manualmente.",
                nextState: "MENU",
                data: { renderMenu: true },
            };
        }
    }

    // REAGENDAR: pedir fecha
    if (step === "ASK_NEW_DATE") {
        if (isBackToMenu(text)) {
            return {
                response: "Volviendo al menú principal.",
                nextState: "MENU",
                data: { renderMenu: true },
            };
        }

        if (!isValidYmd(text)) {
            return {
                response:
                    "Fecha inválida. Escríbela en formato AAAA-MM-DD (ej: 2026-03-05).\n\n0️⃣ Volver al menú",
                nextState: "SOPORTE_CITA",
                data,
            };
        }

        return {
            response:
                "Perfecto. Ahora escribe la hora en formato HH:MM (24h), por ejemplo 14:30.\n\n0️⃣ Volver al menú",
            nextState: "SOPORTE_CITA",
            data: { ...data, step: "ASK_NEW_TIME", newDate: text },
        };
    }

    // REAGENDAR: pedir hora
    if (step === "ASK_NEW_TIME") {
        if (isBackToMenu(text)) {
            return {
                response: "Volviendo al menú principal.",
                nextState: "MENU",
                data: { renderMenu: true },
            };
        }

        if (!isValidHm(text)) {
            return {
                response:
                    "Hora inválida. Escríbela en formato HH:MM (24h), por ejemplo 14:30.\n\n0️⃣ Volver al menú",
                nextState: "SOPORTE_CITA",
                data,
            };
        }

        return {
            response: `Confirmación: reagendar la cita ID ${data.appointmentId} para ${data.newDate} ${text}.\n\nResponde SI para confirmar o NO para abortar.\n\n0️⃣ Volver al menú`,
            nextState: "SOPORTE_CITA",
            data: { ...data, step: "CONFIRM_RESCHEDULE", newTime: text },
        };
    }

    // REAGENDAR: confirmación
    if (step === "CONFIRM_RESCHEDULE") {
        if (isBackToMenu(text)) {
            return {
                response: "Volviendo al menú principal.",
                nextState: "MENU",
                data: { renderMenu: true },
            };
        }

        const yn = normalizeYesNo(text);
        if (!yn) {
            return {
                response:
                    "Por favor responde SI para confirmar o NO para abortar.\n\n0️⃣ Volver al menú",
                nextState: "SOPORTE_CITA",
                data,
            };
        }

        if (yn === "NO") {
            return {
                response:
                    "Listo, no realizamos cambios.\n\nVolviendo al menú principal.",
                nextState: "MENU",
                data: { renderMenu: true },
            };
        }

        try {
            const documento = data.documento;
            const patientDocumentType = Number(data.patientDocumentType || 1);

            const upd = await saludtoolsUpdateAppointment({
                appointmentId: data.appointmentId,
                patientDocumentType,
                patientDocumentNumber: documento,
                startAppointmentYmd: data.newDate,
                startAppointmentHm: data.newTime,
                appointmentType:
                    data.appointmentType || APPOINTMENT_TYPE_DEFAULT,
                comment: data.comment || "",
                data,
            });

            if (!upd.ok) {
                return {
                    response:
                        "No fue posible reagendar la cita en este momento.\n\nPor favor escribe *SECRETARIA* para ayudarte.",
                    nextState: "MENU",
                    data: { renderMenu: true },
                };
            }

            return {
                response:
                    "Tu cita fue reagendada correctamente.\n\nSi necesitas algún ajuste adicional, puedes escribir *SECRETARIA*.",
                nextState: "MENU",
                data: { renderMenu: true },
            };
        } catch (error) {
            console.error(
                "Error en soporteCitaState (CONFIRM_RESCHEDULE):",
                error,
            );
            return {
                response:
                    "Ocurrió un error reagendando tu cita.\n\nPor favor escribe *SECRETARIA* para que podamos ayudarte manualmente.",
                nextState: "MENU",
                data: { renderMenu: true },
            };
        }
    }

    // Fallback general
    return {
        response: "Volviendo al menú principal.",
        nextState: "MENU",
        data: { renderMenu: true },
    };
}
