import "dotenv/config";

import {
    pickNextSaludtoolsJob,
    markSaludtoolsJobDone,
    markSaludtoolsJobRetry,
    markSaludtoolsJobFailed,
} from "../services/saludtools-jobs.service.js";

import {
    createPatientInSaludtools,
    createAppointmentInSaludtools,
} from "../services/saludtools-api.service.js";

import {
    saveSaludtoolsPatientEvent,
    saveSaludtoolsAppointmentEvent,
    updateAppointmentStatusById,
} from "../services/chatbot-db.service.js";

import { sendWhatsAppMessage } from "../services/whatsapp.service.js";

const POLL_MS = 4000;

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function calculateBackoff(attempts) {
    return Math.min(300, Math.max(20, attempts * 20));
}

function extractSaludtoolsId(resp) {
    return (
        resp?.body?.id ||
        resp?.id ||
        resp?.data?.id ||
        resp?.body?.content?.[0]?.id ||
        null
    );
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

async function processPatientCreate(job) {
    const payload = job.payload || {};
    const patientBody = payload.patientBody || {};

    try {
        const resp = await createPatientInSaludtools(patientBody);
        const saludtoolsId = extractSaludtoolsId(resp);

        await saveSaludtoolsPatientEvent({
            saludtoolsId,
            eventType: "PATIENT_CREATE",
            fullName: payload.fullName || "Paciente WhatsApp",
            birthDate: patientBody.birthDate || null,
            gender: patientBody.gender || null,
            habeasData: patientBody.habeasData ?? null,
            rawPayload: resp,
        });

        await markSaludtoolsJobDone(
            job.id,
            saludtoolsId ? String(saludtoolsId) : null,
        );

        await sendWhatsAppMessage(
            job.phone,
            "✅ Tu paciente fue registrado correctamente. Ya puedes continuar con la creación de tu cita.",
        );
    } catch (error) {
        const status = error?.status;
        const retryable = [429, 500, 502, 503, 504].includes(status);
        const lastError = safeErrorMessage(error);

        if (retryable && job.attempts < job.max_attempts) {
            await markSaludtoolsJobRetry(
                job.id,
                lastError,
                calculateBackoff(job.attempts),
            );
            return;
        }

        await markSaludtoolsJobFailed(job.id, lastError);

        await sendWhatsAppMessage(
            job.phone,
            "⚠️ No fue posible completar tu registro en este momento. Nuestro equipo revisará tu caso.",
        );
    }
}

async function processAppointmentCreate(job) {
    const payload = job.payload || {};
    const appointmentBody = payload.appointmentBody || {};

    try {
        const resp = await createAppointmentInSaludtools(appointmentBody);
        const saludtoolsId = extractSaludtoolsId(resp);

        const startAppointment = String(appointmentBody.startAppointment || "");
        const endAppointment = String(appointmentBody.endAppointment || "");

        await saveSaludtoolsAppointmentEvent({
            saludtoolsId,
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
            rawPayload: resp,
        });

        if (job.appointment_id) {
            await updateAppointmentStatusById(job.appointment_id, "CONFIRMED");
        }

        await markSaludtoolsJobDone(
            job.id,
            saludtoolsId ? String(saludtoolsId) : null,
        );

        await sendWhatsAppMessage(
            job.phone,
            `✅ Tu cita fue creada correctamente para ${payload.dateLabel || "la fecha seleccionada"} a las ${payload.timeLabel || "hora seleccionada"}.`,
        );
    } catch (error) {
        const status = error?.status;
        const retryable = [429, 500, 502, 503, 504].includes(status);
        const lastError = safeErrorMessage(error);

        if (retryable && job.attempts < job.max_attempts) {
            await markSaludtoolsJobRetry(
                job.id,
                lastError,
                calculateBackoff(job.attempts),
            );
            return;
        }

        if (job.appointment_id) {
            await updateAppointmentStatusById(job.appointment_id, "FAILED");
        }

        await markSaludtoolsJobFailed(job.id, lastError);

        await sendWhatsAppMessage(
            job.phone,
            "⚠️ No fue posible crear tu cita en este momento. Nuestro equipo revisará tu caso.",
        );
    }
}

async function run() {
    console.log("[saludtools.worker] iniciado");
    console.log("[saludtools.worker] DB env", {
        host: process.env.DB_HOST,
        user: process.env.DB_USER,
        passwordLoaded: !!process.env.DB_PASS,
        database: process.env.DB_NAME,
    });

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

            if (job.job_type === "PATIENT_CREATE") {
                await processPatientCreate(job);
            } else if (job.job_type === "APPOINTMENT_CREATE") {
                await processAppointmentCreate(job);
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
