import { db } from "../db/mysql.js";

function normalizeDdMmToYmd(value) {
    const raw = String(value || "").trim();

    if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
        return raw;
    }

    if (/^\d{2}\/\d{2}$/.test(raw)) {
        const [day, month] = raw.split("/").map(Number);
        const year = new Date().getFullYear();
        const d = new Date(year, month - 1, day);

        const yyyy = String(d.getFullYear()).padStart(4, "0");
        const mm = String(d.getMonth() + 1).padStart(2, "0");
        const dd = String(d.getDate()).padStart(2, "0");

        return `${yyyy}-${mm}-${dd}`;
    }

    return raw;
}

async function getOrCreatePatient(phone, fullName = null) {
    const safeName =
        typeof fullName === "string" && fullName.trim()
            ? fullName.trim()
            : "Paciente WhatsApp";

    const [p] = await db.query(
        "SELECT id, full_name FROM patients WHERE phone = ?",
        [phone],
    );

    if (p.length) {
        const currentName = p[0].full_name;

        const isPlaceholder =
            !currentName ||
            String(currentName).trim().toLowerCase() ===
                "paciente whatsapp".toLowerCase();

        const incomingIsReal =
            typeof fullName === "string" && fullName.trim().length >= 3;

        if (incomingIsReal && isPlaceholder) {
            await db.query("UPDATE patients SET full_name = ? WHERE id = ?", [
                safeName,
                p[0].id,
            ]);
        }

        return p[0].id;
    }

    const [r] = await db.query(
        "INSERT INTO patients (phone, full_name) VALUES (?, ?)",
        [phone, safeName],
    );

    return r.insertId;
}

export async function upsertPatientName(phone, fullName) {
    const safeName =
        typeof fullName === "string" && fullName.trim()
            ? fullName.trim()
            : null;

    if (!safeName) return false;

    const [u] = await db.query(
        "UPDATE patients SET full_name = ? WHERE phone = ?",
        [safeName, phone],
    );

    if (u.affectedRows && u.affectedRows > 0) return true;

    await db.query("INSERT INTO patients (phone, full_name) VALUES (?, ?)", [
        phone,
        safeName,
    ]);

    return true;
}

export async function registerChatbotInteraction({
    phone,
    message,
    appointmentId = null,
    createAppointment = false,
    appointmentData = null,
}) {
    const patientId = await getOrCreatePatient(phone);

    if (!appointmentId && createAppointment) {
        const [a] = await db.query(
            `
            INSERT INTO appointments
            (patient_id, status, source)
            VALUES (?, 'PROPOSED', 'BOT')
            `,
            [patientId],
        );
        appointmentId = a.insertId;

        await db.query(
            `
            INSERT INTO appointment_status_history
            (appointment_id, previous_status, new_status, changed_by)
            VALUES (?, NULL, 'CHAT_STARTED', 'SYSTEM')
            `,
            [appointmentId],
        );
    }

    if (appointmentId && message) {
        await db.query(
            `
            INSERT INTO appointment_messages
            (appointment_id, direction, message, channel, provider)
            VALUES (?, 'IN', ?, 'WHATSAPP', 'TWILIO')
            `,
            [appointmentId, message],
        );
    }

    if (appointmentId && appointmentData?.newStatus) {
        await db.query(
            `
            INSERT INTO appointment_status_history
            (appointment_id, previous_status, new_status, changed_by)
            VALUES (?, ?, ?, 'SYSTEM')
            `,
            [
                appointmentId,
                appointmentData.previousStatus || null,
                appointmentData.newStatus,
            ],
        );
    }

    return appointmentId;
}

export async function createFinalAppointment({ phone, fullName, date, time }) {
    const patientId = await getOrCreatePatient(phone, fullName);

    const [day, month] = date.split("/");
    const year = new Date().getFullYear();
    const normalizedDate = `${year}-${month}-${day}`;

    const [a] = await db.query(
        `
        INSERT INTO appointments
        (patient_id, scheduled_date, scheduled_time, status, source)
        VALUES (?, ?, ?, 'PROPOSED', 'BOT')
        `,
        [patientId, normalizedDate, time],
    );

    await db.query(
        `
        INSERT INTO appointment_status_history
        (appointment_id, previous_status, new_status, changed_by)
        VALUES (?, NULL, 'REDIRECTED', 'SYSTEM')
        `,
        [a.insertId],
    );

    return a.insertId;
}

export async function getPendingCases() {
    const [rows] = await db.query(`
        SELECT
            a.id AS appointment_id,
            COALESCE(p.full_name, sp.full_name, 'Paciente sin identificar') AS full_name,
            p.phone AS phone,
            sa.status,
            DATE_FORMAT(sa.start_date, '%Y-%m-%d') AS date,
            TIME_FORMAT(sa.start_time, '%H:%i:%s') AS time,
            sa.saludtools_id AS saludtools_appointment_id,
            sa.patient_document_type,
            sa.patient_document_number,
            sa.updated_at AS last_update,
            sa.event_type,
            sa.clinic,
            a.duration_minutes,
            a.status AS internal_status
        FROM saludtools_appointments sa
        LEFT JOIN saludtools_patients sp
            ON sp.document_type = sa.patient_document_type
           AND sp.document_number = sa.patient_document_number
        LEFT JOIN patients p
            ON LOWER(TRIM(p.full_name)) = LOWER(TRIM(sp.full_name))
        LEFT JOIN appointments a
            ON a.patient_id = p.id
           AND a.scheduled_date = sa.start_date
           AND TIME(a.scheduled_time) = TIME(sa.start_time)
        WHERE sa.status IN ('PENDING', 'CONFIRMED')
        ORDER BY sa.start_date ASC, sa.start_time ASC, sa.updated_at DESC
    `);

    return rows;
}

export async function markReScheduled(
    appointmentId,
    { newDate = null, newTime = null, changedBy = "SECRETARY" } = {},
) {
    const [rows] = await db.query(
        `
        SELECT status, scheduled_date, scheduled_time
        FROM appointments
        WHERE id = ?
        LIMIT 1
        `,
        [appointmentId],
    );

    if (!rows.length) return false;

    const previousStatus = rows[0].status;
    const targetDate = normalizeDdMmToYmd(newDate || rows[0].scheduled_date);
    const targetTime = String(newTime || rows[0].scheduled_time).slice(0, 8);

    await db.query(
        `
        UPDATE appointments
        SET
            scheduled_date = ?,
            scheduled_time = ?,
            status = 'RESCHEDULED'
        WHERE id = ?
        `,
        [targetDate, targetTime, appointmentId],
    );

    await db.query(
        `
        INSERT INTO appointment_status_history
        (appointment_id, previous_status, new_status, changed_by)
        VALUES (?, ?, 'RESCHEDULED', ?)
        `,
        [appointmentId, previousStatus, changedBy],
    );

    return true;
}

export async function confirmAppointment(appointmentId) {
    const [rows] = await db.query(
        "SELECT status FROM appointments WHERE id = ?",
        [appointmentId],
    );

    if (!rows.length) return;

    const previousStatus = rows[0].status;

    await db.query(
        "UPDATE appointments SET status = 'CONFIRMED' WHERE id = ?",
        [appointmentId],
    );

    await db.query(
        `INSERT INTO appointment_status_history
         (appointment_id, previous_status, new_status, changed_by)
         VALUES (?, ?, 'CONFIRMED', 'SYSTEM')`,
        [appointmentId, previousStatus],
    );
}

export async function markCancelled(
    appointmentId,
    { changedBy = "SECRETARY" } = {},
) {
    const [rows] = await db.query(
        "SELECT status FROM appointments WHERE id = ? LIMIT 1",
        [appointmentId],
    );

    if (!rows.length) return false;

    const previousStatus = rows[0].status;

    await db.query(
        "UPDATE appointments SET status = 'CANCELLED' WHERE id = ?",
        [appointmentId],
    );

    await db.query(
        `INSERT INTO appointment_status_history
         (appointment_id, previous_status, new_status, changed_by)
         VALUES (?, ?, 'CANCELLED', ?)`,
        [appointmentId, previousStatus, changedBy],
    );

    return true;
}

export async function createProposedAppointment({
    phone,
    fullName,
    date,
    time,
}) {
    const safeName =
        typeof fullName === "string" && fullName.trim()
            ? fullName.trim()
            : "Paciente WhatsApp";

    const [patient] = await db.query(
        `SELECT id, full_name FROM patients WHERE phone = ?`,
        [phone],
    );

    let patientId;

    if (patient.length) {
        patientId = patient[0].id;

        const currentName = patient[0].full_name;
        const isPlaceholder =
            !currentName ||
            String(currentName).trim().toLowerCase() ===
                "paciente whatsapp".toLowerCase();

        const incomingIsReal =
            typeof fullName === "string" && fullName.trim().length >= 3;

        if (incomingIsReal && isPlaceholder) {
            await db.query("UPDATE patients SET full_name = ? WHERE id = ?", [
                safeName,
                patientId,
            ]);
        }
    } else {
        const [result] = await db.query(
            `INSERT INTO patients (full_name, phone) VALUES (?, ?)`,
            [safeName, phone],
        );
        patientId = result.insertId;
    }

    const [day, month] = date.split("/");
    const year = new Date().getFullYear();
    const scheduledDate = `${year}-${month}-${day}`;

    const [appointmentResult] = await db.query(
        `INSERT INTO appointments
         (patient_id, scheduled_date, scheduled_time, status, source)
         VALUES (?, ?, ?, 'PROPOSED', 'BOT')`,
        [patientId, scheduledDate, time],
    );

    const appointmentId = appointmentResult.insertId;

    await db.query(
        `INSERT INTO appointment_status_history
         (appointment_id, previous_status, new_status, changed_by)
         VALUES (?, NULL, 'PROPOSED', 'SYSTEM')`,
        [appointmentId],
    );

    return appointmentId;
}

export async function logAppointmentMessage(appointmentId, message) {
    await db.query(
        `INSERT INTO appointment_messages
         (appointment_id, direction, message, channel, provider)
         VALUES (?, 'IN', ?, 'SYSTEM', 'SYSTEM')`,
        [appointmentId, message],
    );
}

export async function updateAppointmentStatusById(appointmentId, newStatus) {
    const [rows] = await db.query(
        "SELECT status FROM appointments WHERE id = ? LIMIT 1",
        [appointmentId],
    );

    const previousStatus = rows?.[0]?.status || null;

    await db.query("UPDATE appointments SET status = ? WHERE id = ?", [
        newStatus,
        appointmentId,
    ]);

    await db.query(
        `INSERT INTO appointment_status_history
         (appointment_id, previous_status, new_status, changed_by)
         VALUES (?, ?, ?, 'SYSTEM')`,
        [appointmentId, previousStatus, newStatus],
    );
}

export async function findLocalSaludtoolsAppointmentById(saludtoolsId) {
    const [rows] = await db.query(
        `
        SELECT
            saludtools_id,
            status,
            start_date,
            start_time,
            end_date,
            end_time,
            doctor_document_number,
            patient_document_type,
            patient_document_number,
            clinic,
            raw_payload
        FROM saludtools_appointments
        WHERE saludtools_id = ?
        ORDER BY id DESC
        LIMIT 1
        `,
        [String(saludtoolsId)],
    );

    return rows?.[0] || null;
}

export async function markLocalSaludtoolsAppointmentCancelled(
    saludtoolsId,
    rawPayload = null,
) {
    await db.query(
        `
        UPDATE saludtools_appointments
        SET
            status = 'CANCELLED',
            raw_payload = COALESCE(?, raw_payload)
        WHERE saludtools_id = ?
        `,
        [rawPayload ? JSON.stringify(rawPayload) : null, String(saludtoolsId)],
    );
}

export async function saveSaludtoolsPatientEvent({
    saludtoolsId,
    eventType,
    fullName,
    documentType,
    documentNumber,
    birthDate = null,
    gender = null,
    habeasData = null,
    rawPayload = null,
}) {
    await db.query(
        `INSERT INTO saludtools_patients
         (
            saludtools_id,
            event_type,
            full_name,
            birth_date,
            gender,
            habeas_data,
            raw_payload,
            document_type,
            document_number
         )
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
            event_type = VALUES(event_type),
            full_name = VALUES(full_name),
            birth_date = VALUES(birth_date),
            gender = VALUES(gender),
            habeas_data = VALUES(habeas_data),
            raw_payload = VALUES(raw_payload),
            document_type = VALUES(document_type),
            document_number = VALUES(document_number),
            updated_at = CURRENT_TIMESTAMP`,
        [
            saludtoolsId || 0,
            eventType || "",
            fullName || "Paciente WhatsApp",
            birthDate,
            gender,
            habeasData,
            rawPayload ? JSON.stringify(rawPayload) : null,
            Number(documentType),
            String(documentNumber || "").trim(),
        ],
    );
}

export async function saveSaludtoolsAppointmentEvent({
    saludtoolsId,
    eventType,
    status,
    startDate,
    startTime,
    endDate = null,
    endTime = null,
    doctorDocumentNumber,
    patientDocumentType,
    patientDocumentNumber,
    clinic = null,
    rawPayload = null,
}) {
    await db.query(
        `INSERT INTO saludtools_appointments
(
  saludtools_id,
  event_type,
  status,
  start_date,
  start_time,
  end_date,
  end_time,
  doctor_document_number,
  patient_document_type,
  patient_document_number,
  clinic,
  raw_payload
)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)

ON DUPLICATE KEY UPDATE
  event_type = VALUES(event_type),
  status = VALUES(status),
  start_date = VALUES(start_date),
  start_time = VALUES(start_time),
  end_date = VALUES(end_date),
  end_time = VALUES(end_time),
  doctor_document_number = VALUES(doctor_document_number),
  patient_document_type = VALUES(patient_document_type),
  patient_document_number = VALUES(patient_document_number),
  clinic = VALUES(clinic),
  raw_payload = VALUES(raw_payload)
`,
        [
            saludtoolsId,
            eventType,
            status,
            startDate,
            startTime,
            endDate,
            endTime,
            doctorDocumentNumber,
            patientDocumentType,
            patientDocumentNumber,
            clinic,
            rawPayload ? JSON.stringify(rawPayload) : null,
        ],
    );
}

export async function createDashboardQuickAppointment({
    saludtoolsId,
    eventType,
    status,
    startDate,
    startTime,
    endDate,
    endTime,
    doctorDocumentNumber,
    patientDocumentType,
    patientDocumentNumber,
    clinic,
    rawPayload,
}) {
    const [result] = await db.query(
        `INSERT INTO saludtools_appointments (
            saludtools_id,
            event_type,
            status,
            start_date,
            start_time,
            end_date,
            end_time,
            doctor_document_number,
            patient_document_type,
            patient_document_number,
            clinic,
            raw_payload
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
            Number(saludtoolsId),
            String(eventType),
            String(status),
            String(startDate),
            String(startTime),
            endDate ? String(endDate) : null,
            endTime ? String(endTime) : null,
            String(doctorDocumentNumber),
            Number(patientDocumentType),
            String(patientDocumentNumber),
            clinic != null ? String(clinic) : null,
            rawPayload ? JSON.stringify(rawPayload) : null,
        ],
    );

    return result.insertId;
}
