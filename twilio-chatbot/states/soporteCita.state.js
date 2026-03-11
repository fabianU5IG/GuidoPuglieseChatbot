import { db } from "../db/mysql.js";
import { createSaludtoolsJob } from "../services/saludtools-jobs.service.js";

const APPOINTMENT_DURATION_MIN = 20;

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

function addMinutesToYmdHm(ymd, hm, minutes) {
    const [y, m, d] = ymd.split("-").map(Number);
    const [hh, mm] = hm.split(":").map(Number);
    const dt = new Date(y, m - 1, d, hh, mm, 0, 0);
    dt.setMinutes(dt.getMinutes() + Number(minutes || 0));

    const y2 = dt.getFullYear();
    const m2 = String(dt.getMonth() + 1).padStart(2, "0");
    const d2 = String(dt.getDate()).padStart(2, "0");
    const hh2 = String(dt.getHours()).padStart(2, "0");
    const mm2 = String(dt.getMinutes()).padStart(2, "0");

    return { ymd: `${y2}-${m2}-${d2}`, hm: `${hh2}:${mm2}` };
}

function formatAppointmentLine(item, idx) {
    const id = item?.saludtools_id || item?.id || "";
    const start =
        `${item?.start_date || ""} ${String(item?.start_time || "").slice(0, 5)}`.trim();
    const end =
        `${item?.end_date || ""} ${String(item?.end_time || "").slice(0, 5)}`.trim();
    const modality = item?.modality || "";
    const appointmentType = item?.appointment_type || "";

    return `${idx + 1}️⃣ ID ${id} | ${start}${end ? " - " + end : ""}${modality ? " | " + modality : ""}${appointmentType ? " | " + appointmentType : ""}`;
}

async function findLocalPatientByDocument(documentNumber) {
    const [rows] = await db.query(
        `
        SELECT saludtools_id, document_type, document_number, full_name
        FROM saludtools_patients
        WHERE document_number = ?
        LIMIT 1
        `,
        [String(documentNumber)],
    );

    return rows?.[0] || null;
}

async function findLocalAppointmentsByDocument(documentNumber) {
    const [rows] = await db.query(
        `
        SELECT
            saludtools_id,
            patient_document_type,
            patient_document_number,
            doctor_document_number,
            start_date,
            start_time,
            end_date,
            end_time,
            status,
            clinic
        FROM saludtools_appointments
        WHERE patient_document_number = ?
        ORDER BY start_date DESC, start_time DESC
        LIMIT 10
        `,
        [String(documentNumber)],
    );

    return Array.isArray(rows) ? rows : [];
}

export default async function soporteCitaState(msg, data = {}, context = {}) {
    const phone = context.from || "UNKNOWN";
    const { tipo, step } = data;
    const text = String(msg || "").trim();

    if (!step) {
        return {
            response:
                "Por favor escribe tu número de documento (sin puntos ni espacios):\n\n0️⃣ Volver al menú",
            nextState: "SOPORTE_CITA",
            data: { ...data, step: "ASK_DOCUMENT" },
        };
    }

    if (step === "ASK_DOCUMENT") {
        if (isBackToMenu(text)) {
            return {
                response: "Volviendo al menú principal.",
                nextState: "MENU",
                data: { renderMenu: true },
            };
        }

        if (!/^\d+$/.test(text)) {
            return {
                response:
                    "El número de documento debe contener solo números. Intenta nuevamente:\n\n0️⃣ Volver al menú",
                nextState: "SOPORTE_CITA",
                data,
            };
        }

        const documento = text;

        try {
            const patient = await findLocalPatientByDocument(documento);
            const citas = await findLocalAppointmentsByDocument(documento);

            if (!patient && !citas.length) {
                await createSaludtoolsJob({
                    jobType: "SUPPORT_APPOINTMENT_SEARCH",
                    phone,
                    dedupeKey: `support-search:${documento}:${tipo || "SOPORTE"}`,
                    payload: {
                        documento,
                        tipo,
                    },
                    priority: 90,
                });

                return {
                    response:
                        "No encontré información local con ese documento.\n\n" +
                        "Tu solicitud quedó en proceso y validaremos la información en el sistema. " +
                        "Te avisaremos por este medio.\n\n" +
                        "Volviendo al menú principal.",
                    nextState: "MENU",
                    data: { renderMenu: true },
                };
            }

            if (!citas.length) {
                await createSaludtoolsJob({
                    jobType: "SUPPORT_APPOINTMENT_SEARCH",
                    phone,
                    dedupeKey: `support-search:${documento}:${tipo || "SOPORTE"}`,
                    payload: {
                        documento,
                        tipo,
                        patientDocumentType: Number(
                            patient?.document_type || 1,
                        ),
                    },
                    priority: 90,
                });

                return {
                    response:
                        "No encontré citas locales asociadas a ese documento.\n\n" +
                        "Tu solicitud quedó en proceso y validaremos las citas en el sistema. " +
                        "Te avisaremos por este medio.\n\n" +
                        "Volviendo al menú principal.",
                    nextState: "MENU",
                    data: { renderMenu: true },
                };
            }

            const lines = citas.map((it, idx) =>
                formatAppointmentLine(it, idx),
            );

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
                    documento,
                    patientDocumentType: Number(
                        patient?.document_type ||
                            citas[0]?.patient_document_type ||
                            1,
                    ),
                    citas,
                },
            };
        } catch (error) {
            console.error("Error en soporteCitaState (ASK_DOCUMENT):", error);
            return {
                response:
                    "Ocurrió un error consultando tu información.\n\nPor favor intenta nuevamente o escribe *SECRETARIA*.",
                nextState: "MENU",
                data: { renderMenu: true },
            };
        }
    }

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
        const appointmentId = cita?.saludtools_id || cita?.id;

        if (!appointmentId) {
            return {
                response:
                    "No pudimos identificar la cita seleccionada.\n\nPor favor escribe *SECRETARIA* para ayudarte.",
                nextState: "MENU",
                data: { renderMenu: true },
            };
        }

        if (tipo === "CANCELAR") {
            return {
                response: `Vas a cancelar la cita ID ${appointmentId}.\n\nResponde SI para confirmar o NO para abortar.\n\n0️⃣ Volver al menú`,
                nextState: "SOPORTE_CITA",
                data: {
                    ...data,
                    step: "CONFIRM_CANCEL",
                    appointmentId,
                    selectedIndex: idx,
                },
            };
        }

        return {
            response: `Vas a reagendar la cita ID ${appointmentId}.\n\nEscribe la nueva fecha en formato AAAA-MM-DD (ej: 2026-03-05).\n\n0️⃣ Volver al menú`,
            nextState: "SOPORTE_CITA",
            data: {
                ...data,
                step: "ASK_NEW_DATE",
                appointmentId,
                selectedIndex: idx,
            },
        };
    }

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
        const cita = data.citas[data.selectedIndex];

        await createSaludtoolsJob({
            jobType: "APPOINTMENT_DELETE",
            phone,
            dedupeKey: `appointment-delete:${data.appointmentId}`,
            payload: {
                appointmentId: data.appointmentId,
                documento: data.documento,
                patientDocumentType: Number(data.patientDocumentType || 1),
                startDate: cita.start_date,
                startTime: cita.start_time,
                endDate: cita.end_date,
                endTime: cita.end_time,
            },
            priority: 100,
        });

        return {
            response:
                "Tu solicitud de cancelación quedó en proceso.\n\n" +
                "Te avisaremos por este medio cuando quede aplicada.\n\n" +
                "Volviendo al menú principal.",
            nextState: "MENU",
            data: { renderMenu: true },
        };
    }

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

        const selectedAppointment =
            Array.isArray(data.citas) && Number.isInteger(data.selectedIndex)
                ? data.citas[data.selectedIndex]
                : null;

        const end = addMinutesToYmdHm(
            data.newDate,
            data.newTime,
            APPOINTMENT_DURATION_MIN,
        );

        await createSaludtoolsJob({
            jobType: "APPOINTMENT_UPDATE",
            phone,
            dedupeKey: `appointment-update:${data.appointmentId}:${data.newDate}:${data.newTime}`,
            payload: {
                appointmentId: data.appointmentId,
                documento: data.documento,
                patientDocumentType: Number(
                    data.patientDocumentType ||
                        selectedAppointment?.patient_document_type ||
                        1,
                ),
                appointmentBody: {
                    id: String(data.appointmentId),
                    startAppointment: `${data.newDate} ${data.newTime}`,
                    endAppointment: `${end.ymd} ${end.hm}`,
                    patientDocumentType: Number(
                        data.patientDocumentType ||
                            selectedAppointment?.patient_document_type ||
                            1,
                    ),
                    patientDocumentNumber: String(data.documento),
                    doctorDocumentType: 1,
                    doctorDocumentNumber: String(
                        selectedAppointment?.doctor_document_number ||
                            process.env.SALUDTOOLS_DOCTOR_DOCUMENT_NUMBER ||
                            "72134079",
                    ),
                    modality: "CONVENTIONAL",
                    stateAppointment: "PENDING",
                    notificationState: "ATTEND",
                    appointmentType:
                        selectedAppointment?.appointment_type ||
                        process.env.SALUDTOOLS_APPOINTMENT_TYPE ||
                        "Pruebas Luis",
                    clinic: Number(
                        selectedAppointment?.clinic ||
                            process.env.SALUDTOOLS_CLINIC_ID ||
                            18569,
                    ),
                    comment: `Reagendada por chatbot. Documento: ${data.documento}`,
                },
            },
            priority: 100,
        });

        return {
            response:
                "Tu solicitud de reagendamiento quedó en proceso.\n\n" +
                "Te avisaremos por este medio cuando quede aplicada.\n\n" +
                "Volviendo al menú principal.",
            nextState: "MENU",
            data: { renderMenu: true },
        };
    }

    return {
        response: "Volviendo al menú principal.",
        nextState: "MENU",
        data: { renderMenu: true },
    };
}
