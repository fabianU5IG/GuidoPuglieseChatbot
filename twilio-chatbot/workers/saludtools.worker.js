import "dotenv/config";

import {
    pickNextSaludtoolsJob,
    markSaludtoolsJobDone,
    markSaludtoolsJobRetry,
    markSaludtoolsJobFailed,
} from "../services/saludtools-jobs.service.js";

import {
    readPatientInSaludtools,
    searchPatientInSaludtools,
    createPatientInSaludtools,
    searchAppointmentsInSaludtools,
    createAppointmentInSaludtools,
    searchAppointmentsByPatientInSaludtools,
    updateAppointmentInSaludtools,
    deleteAppointmentInSaludtools,
} from "../services/saludtools-api.service.js";

import {
    saveSaludtoolsPatientEvent,
    saveSaludtoolsAppointmentEvent,
    updateAppointmentStatusById,
    findLocalSaludtoolsAppointmentById,
    markLocalSaludtoolsAppointmentCancelled,
} from "../services/chatbot-db.service.js";

import { sendWhatsAppMessage } from "../services/whatsapp.service.js";

const POLL_MS = 4000;
const RETRY_DELAY_SECONDS = 60;

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function safeErrorMessage(error) {
    try {
        if (error?.response) return JSON.stringify(error.response);
        if (error?.message) return String(error.message);
        return JSON.stringify(error);
    } catch {
        return "Unknown worker error";
    }
}

function extractSaludtoolsId(resp) {
    return (
        resp?.body?.id ||
        resp?.body?.content?.[0]?.id ||
        resp?.id ||
        resp?.data?.id ||
        null
    );
}

function extractPatientExists(resp) {
    const body = resp?.body;
    if (Array.isArray(body?.content)) return body.content.length > 0;
    if (extractSaludtoolsId(resp)) return true;
    return false;
}

function isCancelledAppointment(item) {
    const status = String(
        item?.stateAppointment || item?.status || "",
    ).toUpperCase();

    return status === "CANCELLED" || status === "CANCELED";
}

function hasAppointmentConflict(
    resp,
    targetStart,
    targetEnd,
    currentAppointmentId = null,
) {
    const content = resp?.body?.content;
    if (!Array.isArray(content) || !content.length) return false;

    const targetStartMin = dateTimeToEpochMinutes(targetStart);
    const targetEndMin = dateTimeToEpochMinutes(targetEnd);
    const targetDuration =
        Number.isFinite(targetStartMin) && Number.isFinite(targetEndMin)
            ? Math.max(1, targetEndMin - targetStartMin)
            : 20;

    return content.some((item) => {
        const sameAppointment =
            currentAppointmentId &&
            String(item?.id || item?.saludtools_id || "") ===
                String(currentAppointmentId);

        if (sameAppointment) return false;
        if (isCancelledAppointment(item)) return false;

        const existingStart = dateTimeToEpochMinutes(
            item?.startAppointment || item?.start_date,
        );
        const parsedExistingEnd = dateTimeToEpochMinutes(
            item?.endAppointment || item?.end_date,
        );
        const existingEnd = Number.isFinite(parsedExistingEnd)
            ? parsedExistingEnd
            : existingStart + targetDuration;

        if (
            Number.isFinite(targetStartMin) &&
            Number.isFinite(targetEndMin) &&
            Number.isFinite(existingStart) &&
            Number.isFinite(existingEnd)
        ) {
            return targetStartMin < existingEnd && existingStart < targetEndMin;
        }

        return (
            normalizeDateTime(item?.startAppointment || item?.start_date) ===
            normalizeDateTime(targetStart)
        );
    });
}

function dateTimeToEpochMinutes(value) {
    const match = String(value || "")
        .replace("T", " ")
        .match(/^(\d{4})-(\d{2})-(\d{2})\s+(\d{1,2}):(\d{2})/);

    if (!match) return null;

    const [, year, month, day, hour, minute] = match.map(Number);
    return Date.UTC(year, month - 1, day, hour, minute) / 60_000;
}

function normalizeErrorText(error) {
    const parts = [
        error?.message,
        error?.response?.message,
        error?.response?.raw,
        error?.response?.body?.message,
    ];

    return parts
        .filter(Boolean)
        .join(" ")
        .toLowerCase()
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "");
}

function isSlotUnavailableError(error) {
    if (Number(error?.businessCode) === 409) return true;

    const text = normalizeErrorText(error);
    if (text.includes("appointment slot already occupied")) return true;

    const mentionsSlot =
        text.includes("horario") ||
        text.includes("hora") ||
        text.includes("cita") ||
        text.includes("appointment");

    const unavailable =
        text.includes("no disponible") ||
        text.includes("ocupad") ||
        text.includes("cruce") ||
        text.includes("se solapa") ||
        text.includes("overlap") ||
        text.includes("ya existe una cita");

    return mentionsSlot && unavailable;
}

// Se manda una sola vez por solicitud (al 5to intento, ~5 minutos), no en cada
// reintento — antes se repetía cada 5 intentos y el paciente podía recibir el
// mismo aviso de "seguimos procesando" 5+ veces seguidas en una sola solicitud
// que tardó en resolverse, lo cual se siente como spam en su WhatsApp.
function shouldSendWaitingMessage(nextAttempts) {
    return nextAttempts === 5;
}

async function safeSendWhatsApp(phone, body) {
    try {
        await sendWhatsAppMessage(phone, body);
    } catch (error) {
        console.error("[saludtools.worker] whatsapp notify error", {
            phone,
            message: safeErrorMessage(error),
        });
    }
}

function formatAppointmentForUser(item, idx) {
    const id = item?.id || item?.saludtools_id || "";
    const start = String(item?.startAppointment || "").replace("T", " ");
    const end = String(item?.endAppointment || "").replace("T", " ");
    const state = item?.stateAppointment || item?.status || "";
    return `${idx + 1}️⃣ ID ${id} | ${start}${end ? " - " + end : ""}${state ? ` | ${state}` : ""}`;
}

async function ensurePatientExists(patientBody) {
    try {
        const readResp = await readPatientInSaludtools(
            patientBody.documentType,
            patientBody.documentNumber,
        );

        if (extractPatientExists(readResp)) {
            return readResp;
        }
    } catch {}

    try {
        const searchResp = await searchPatientInSaludtools(
            patientBody.documentNumber,
            patientBody.firstName || "",
        );

        if (extractPatientExists(searchResp)) {
            return searchResp;
        }
    } catch {}

    return createPatientInSaludtools(patientBody);
}

async function handleRetryOrFail({
    job,
    error,
    userWaitingMessage,
    userFailMessage,
    onFinalFail,
}) {
    const status = error?.status;
    const businessCode = error?.businessCode;

    const retryable =
        [429, 500, 502, 503, 504].includes(status) ||
        [412].includes(businessCode);

    const lastError = safeErrorMessage(error);
    const nextAttempts = Number(job.attempts || 0) + 1;
    const maxAttempts = Number(job.max_attempts || 30);

    if (retryable && nextAttempts < maxAttempts) {
        if (shouldSendWaitingMessage(nextAttempts) && userWaitingMessage) {
            await safeSendWhatsApp(job.phone, userWaitingMessage);
        }

        await markSaludtoolsJobRetry(job.id, lastError, RETRY_DELAY_SECONDS);
        return;
    }

    if (typeof onFinalFail === "function") {
        await onFinalFail();
    }

    await markSaludtoolsJobFailed(job.id, lastError);

    if (userFailMessage) {
        await safeSendWhatsApp(job.phone, userFailMessage);
    }
}
function normalizeDateTime(value) {
    return String(value || "")
        .replace("T", " ")
        .slice(0, 16);
}

function extractCreatedAppointmentIdFromMessage(message = "") {
    const text = String(message || "");
    const match = text.match(/id:\s*(\d+)/i);
    return match ? match[1] : null;
}

function findCreatedAppointmentCandidate(resp, appointmentBody) {
    const targetStart = normalizeDateTime(appointmentBody?.startAppointment);
    const targetPatientDoc = String(
        appointmentBody?.patientDocumentNumber || "",
    ).trim();

    // 1) Caso válido: Saludtools devuelve el id en el root
    if (resp?.id && Number(resp?.code) === 200) {
        return {
            id: resp.id,
            startAppointment: appointmentBody?.startAppointment,
            patientDocumentNumber: appointmentBody?.patientDocumentNumber,
            source: "root",
        };
    }

    // 2) Caso válido: el mensaje confirma registro
    const idFromMessage = extractCreatedAppointmentIdFromMessage(resp?.message);
    if (idFromMessage && Number(resp?.code) === 200) {
        return {
            id: idFromMessage,
            startAppointment: appointmentBody?.startAppointment,
            patientDocumentNumber: appointmentBody?.patientDocumentNumber,
            source: "message",
        };
    }

    // 3) Caso válido: body trae la cita directa
    const directBody = resp?.body;
    if (
        directBody &&
        directBody.id &&
        normalizeDateTime(directBody.startAppointment) === targetStart &&
        !isCancelledAppointment(directBody)
    ) {
        return {
            ...directBody,
            source: "body",
        };
    }

    // 4) Caso válido: body.content trae la cita creada
    const content = resp?.body?.content;
    if (Array.isArray(content)) {
        const found = content.find((item) => {
            const sameStart =
                normalizeDateTime(item?.startAppointment) === targetStart;
            const samePatient =
                String(item?.patientDocumentNumber || "").trim() ===
                targetPatientDoc;

            return sameStart && samePatient && !isCancelledAppointment(item);
        });

        if (found?.id) {
            return {
                ...found,
                source: "content",
            };
        }
    }

    return null;
}

function assertAppointmentCreated(resp, appointmentBody) {
    const candidate = findCreatedAppointmentCandidate(resp, appointmentBody);

    if (!candidate?.id) {
        const err = new Error("Saludtools no confirmó la creación de la cita");
        err.businessCode = 422;
        err.response = resp;
        throw err;
    }

    return candidate;
}
async function processAppointmentCreate(job) {
    const payload = job.payload || {};
    const patientExistsLocal = Boolean(payload.patientExistsLocal);
    const patientBody = payload.patientBody || null;
    const appointmentBody = { ...(payload.appointmentBody || {}) };

    try {
        if (!patientExistsLocal) {
            const patientResp = await ensurePatientExists(patientBody);
            const patientId = extractSaludtoolsId(patientResp);

            await saveSaludtoolsPatientEvent({
                saludtoolsId: patientId,
                eventType: "PATIENT_UPSERT_FROM_APPOINTMENT",
                fullName: payload.fullName || "Paciente WhatsApp",
                documentType: appointmentBody.patientDocumentType || null,
                documentNumber: appointmentBody.patientDocumentNumber || null,
                birthDate: patientBody?.birthDate || null,
                gender: patientBody?.gender || null,
                habeasData: patientBody?.habeasData ?? null,
                rawPayload: patientResp, // Antes era 'resp' (corregido)
            });
        }

        const searchResp = await searchAppointmentsInSaludtools({
            doctorDocumentType: appointmentBody.doctorDocumentType,
            doctorDocumentNumber: appointmentBody.doctorDocumentNumber,
            startAppointment: appointmentBody.startAppointment,
            endAppointment: appointmentBody.endAppointment,
            page: 0,
            size: 19,
        });

        if (
            hasAppointmentConflict(
                searchResp,
                appointmentBody.startAppointment,
                appointmentBody.endAppointment,
            )
        ) {
            throw Object.assign(
                new Error("Appointment slot already occupied"),
                {
                    businessCode: 409,
                    response: searchResp,
                },
            );
        }

        const appointmentResp =
            await createAppointmentInSaludtools(appointmentBody);

        const createdAppointment = assertAppointmentCreated(
            appointmentResp,
            appointmentBody,
        );

        const saludtoolsAppointmentId = createdAppointment.id;

        const startAppointment = String(appointmentBody.startAppointment || "");
        const endAppointment = String(appointmentBody.endAppointment || "");

        await saveSaludtoolsAppointmentEvent({
            saludtoolsId: saludtoolsAppointmentId,
            eventType: "APPOINTMENT_CREATE",
            status: appointmentBody.stateAppointment || "PENDING",
            startDate: startAppointment.slice(0, 10) || null,
            startTime: startAppointment.slice(11, 16) || null,
            endDate: endAppointment ? endAppointment.slice(0, 10) : null,
            endTime: endAppointment ? endAppointment.slice(11, 16) : null,
            doctorDocumentNumber: appointmentBody.doctorDocumentNumber,
            patientDocumentType: appointmentBody.patientDocumentType,
            patientDocumentNumber: appointmentBody.patientDocumentNumber,
            clinic: appointmentBody.clinic || null,
            rawPayload: appointmentResp,
        });

        if (job.appointment_id) {
            await updateAppointmentStatusById(job.appointment_id, "CONFIRMED");
        }

        await markSaludtoolsJobDone(
            job.id,
            saludtoolsAppointmentId ? String(saludtoolsAppointmentId) : null,
        );

        await safeSendWhatsApp(
            job.phone,
            `✅ Tu cita fue creada correctamente para ${payload.dateLabel || "la fecha seleccionada"} a las ${payload.timeLabel || "hora seleccionada"}.`,
        );
    } catch (error) {
        if (isSlotUnavailableError(error)) {
            if (job.appointment_id) {
                await updateAppointmentStatusById(job.appointment_id, "FAILED");
            }

            await markSaludtoolsJobFailed(
                job.id,
                `HORARIO_NO_DISPONIBLE: ${safeErrorMessage(error)}`,
            );

            await safeSendWhatsApp(
                job.phone,
                `El horario ${payload.timeLabel || "seleccionado"} del ${payload.dateLabel || "día solicitado"} ya no está disponible en SaludTools. Escribe *AGENDAR* para escoger una nueva fecha y hora.`,
            );
            return;
        }

        await handleRetryOrFail({
            job,
            error,
            userWaitingMessage:
                "⏳ Seguimos procesando tu solicitud. Aún estamos esperando confirmación del sistema y volveremos a intentarlo en unos minutos.",
            userFailMessage:
                "⚠️ No fue posible crear tu cita en este momento. Nuestro equipo revisará tu caso.",
            onFinalFail: async () => {
                if (job.appointment_id) {
                    await updateAppointmentStatusById(
                        job.appointment_id,
                        "FAILED",
                    );
                }
            },
        });
    }
}

async function processSupportAppointmentSearch(job) {
    const payload = job.payload || {};
    const documento = String(payload.documento || "").trim();
    const patientDocumentType = Number(payload.patientDocumentType || 1);
    const tipo = String(payload.tipo || "SOPORTE");

    try {
        const patientResp = await readPatientInSaludtools(
            patientDocumentType,
            documento,
        );

        let patientFound = extractPatientExists(patientResp);

        if (!patientFound) {
            const patientSearchResp = await searchPatientInSaludtools(
                documento,
                "",
            );
            patientFound = extractPatientExists(patientSearchResp);
        }

        if (!patientFound) {
            await markSaludtoolsJobDone(job.id, null);
            await safeSendWhatsApp(
                job.phone,
                "No encontramos un paciente asociado a ese documento en el sistema. Por favor valida el número o contacta a la secretaria.",
            );
            return;
        }

        const appointmentsResp = await searchAppointmentsByPatientInSaludtools({
            patientDocumentType,
            patientDocumentNumber: documento,
        });

        const content = appointmentsResp?.body?.content || [];

        await markSaludtoolsJobDone(job.id, null);

        if (!Array.isArray(content) || !content.length) {
            await safeSendWhatsApp(
                job.phone,
                "No encontramos citas asociadas a tu documento en el sistema.",
            );
            return;
        }

        const lines = content
            .slice(0, 10)
            .map((it, idx) => formatAppointmentForUser(it, idx));

        const actionText =
            tipo === "CANCELAR"
                ? "cancelar"
                : tipo === "REAGENDAR"
                  ? "reagendar"
                  : "gestionar";

        await safeSendWhatsApp(
            job.phone,
            "Encontramos estas citas asociadas a tu documento:\n\n" +
                lines.join("\n") +
                `\n\nPor favor vuelve al flujo y elige cuál deseas ${actionText}.`,
        );
    } catch (error) {
        await handleRetryOrFail({
            job,
            error,
            userWaitingMessage:
                "⏳ Seguimos validando tus citas en el sistema. Volveremos a intentarlo en unos minutos.",
            userFailMessage:
                "⚠️ No fue posible consultar tus citas en este momento. Nuestro equipo revisará tu caso.",
        });
    }
}

async function processAppointmentUpdate(job) {
    const payload = job.payload || {};
    const appointmentBody = payload.appointmentBody || {};
    const appointmentId = appointmentBody.id || payload.appointmentId || null;

    try {
        const searchResp = await searchAppointmentsInSaludtools({
            doctorDocumentType: Number(appointmentBody.doctorDocumentType || 1),
            doctorDocumentNumber: String(
                appointmentBody.doctorDocumentNumber ||
                    process.env.SALUDTOOLS_DOCTOR_DOCUMENT_NUMBER ||
                    "72134079",
            ),
            startAppointment: appointmentBody.startAppointment,
            endAppointment: appointmentBody.endAppointment,
            page: 0,
            size: 19,
        });

        if (
            hasAppointmentConflict(
                searchResp,
                appointmentBody.startAppointment,
                appointmentBody.endAppointment,
                appointmentId,
            )
        ) {
            throw Object.assign(
                new Error("Appointment slot already occupied"),
                {
                    businessCode: 409,
                    response: searchResp,
                },
            );
        }

        const resp = await updateAppointmentInSaludtools(appointmentBody);
        const saludtoolsAppointmentId =
            extractSaludtoolsId(resp) || appointmentId;

        const startAppointment = String(appointmentBody.startAppointment || "");
        const endAppointment = String(appointmentBody.endAppointment || "");

        await saveSaludtoolsAppointmentEvent({
            saludtoolsId: saludtoolsAppointmentId,
            eventType: "APPOINTMENT_UPDATE",
            status: appointmentBody.stateAppointment || "PENDING",
            startDate: startAppointment.slice(0, 10) || null,
            startTime: startAppointment.slice(11, 16) || null,
            endDate: endAppointment ? endAppointment.slice(0, 10) : null,
            endTime: endAppointment ? endAppointment.slice(11, 16) : null,
            doctorDocumentNumber: appointmentBody.doctorDocumentNumber || null,
            patientDocumentType: appointmentBody.patientDocumentType || null,
            patientDocumentNumber:
                appointmentBody.patientDocumentNumber ||
                payload.documento ||
                null,
            clinic: appointmentBody.clinic || null,
            rawPayload: resp,
        });

        await markSaludtoolsJobDone(
            job.id,
            saludtoolsAppointmentId ? String(saludtoolsAppointmentId) : null,
        );

        await safeSendWhatsApp(
            job.phone,
            `✅ Tu cita fue reagendada correctamente para ${appointmentBody.startAppointment}.`,
        );
    } catch (error) {
        if (isSlotUnavailableError(error)) {
            await markSaludtoolsJobFailed(
                job.id,
                `HORARIO_NO_DISPONIBLE: ${safeErrorMessage(error)}`,
            );

            await safeSendWhatsApp(
                job.phone,
                "El nuevo horario seleccionado ya no está disponible en SaludTools. Escribe *REAGENDAR* para escoger otra fecha y hora.",
            );
            return;
        }

        await handleRetryOrFail({
            job,
            error,
            userWaitingMessage:
                "⏳ Seguimos intentando reagendar tu cita. Volveremos a intentarlo en unos minutos.",
            userFailMessage:
                "⚠️ No fue posible reagendar tu cita en este momento. Nuestro equipo revisará tu caso.",
        });
    }
}

async function processAppointmentDelete(job) {
    const payload = job.payload || {};
    const appointmentId = payload.appointmentId;

    try {
        const localAppointment =
            await findLocalSaludtoolsAppointmentById(appointmentId);

        const resp = await deleteAppointmentInSaludtools({
            id: String(appointmentId),
        });

        if (localAppointment) {
            await markLocalSaludtoolsAppointmentCancelled(appointmentId, resp);
        } else {
            await saveSaludtoolsAppointmentEvent({
                saludtoolsId: appointmentId,
                eventType: "APPOINTMENT_DELETE",
                status: "CANCELLED",
                startDate: payload.startDate || "1900-01-01",
                startTime: payload.startTime || "00:00",
                endDate: payload.endDate || null,
                endTime: payload.endTime || null,
                doctorDocumentNumber: null,
                patientDocumentType: payload.patientDocumentType || null,
                patientDocumentNumber: payload.documento || null,
                clinic: null,
                rawPayload: resp,
            });
        }

        await markSaludtoolsJobDone(
            job.id,
            appointmentId ? String(appointmentId) : null,
        );

        await safeSendWhatsApp(
            job.phone,
            "✅ Tu cita fue cancelada correctamente.",
        );
    } catch (error) {
        await handleRetryOrFail({
            job,
            error,
            userWaitingMessage:
                "⏳ Seguimos intentando cancelar tu cita. Volveremos a intentarlo en unos minutos.",
            userFailMessage:
                "⚠️ No fue posible cancelar tu cita en este momento. Nuestro equipo revisará tu caso.",
        });
    }
}

async function run() {
    console.log("[saludtools.worker] iniciado");

    while (true) {
        try {
            const job = await pickNextSaludtoolsJob();

            if (!job) {
                await sleep(POLL_MS);
                continue;
            }

            console.log(
                `[saludtools.worker] procesando job ${job.id} (${job.job_type})`,
            );

            if (job.job_type === "APPOINTMENT_CREATE") {
                await processAppointmentCreate(job);
            } else if (job.job_type === "SUPPORT_APPOINTMENT_SEARCH") {
                await processSupportAppointmentSearch(job);
            } else if (job.job_type === "APPOINTMENT_UPDATE") {
                await processAppointmentUpdate(job);
            } else if (job.job_type === "APPOINTMENT_DELETE") {
                await processAppointmentDelete(job);
            } else {
                await markSaludtoolsJobFailed(
                    job.id,
                    `Unsupported job_type: ${job.job_type}`,
                );
            }
        } catch (error) {
            console.error("[saludtools.worker] error", error);
            await sleep(POLL_MS);
        }
    }
}

run();
