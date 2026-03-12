import { db } from "../db/mysql.js";

async function getOrCreatePatient(phone, fullName = null) {
    const safeName =
        typeof fullName === "string" && fullName.trim()
            ? fullName.trim()
            : "Paciente WhatsApp";

    // Traer también el nombre actual para poder actualizarlo si llega después
    const [p] = await db.query(
        "SELECT id, full_name FROM patients WHERE phone = ?",
        [phone],
    );

    if (p.length) {
        const currentName = p[0].full_name;

        // Si el paciente existe y ahora llega un nombre "real", lo guardamos
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

/* ======================================================
   UPSERT – actualizar/crear nombre del paciente
====================================================== */
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

    // Si no existe aún, lo creamos con nombre (evita NULL)
    await db.query("INSERT INTO patients (phone, full_name) VALUES (?, ?)", [
        phone,
        safeName,
    ]);

    return true;
}

/* ======================================================
   REGISTRO DE INTERACCIONES (CHATBOT)
====================================================== */
export async function registerChatbotInteraction({
    phone,
    message,
    appointmentId = null,
    createAppointment = false,
    appointmentData = null,
}) {
    const patientId = await getOrCreatePatient(phone);

    /* =========================
       Crear cita SOLO una vez
    ========================= */
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

        // historial
        await db.query(
            `
            INSERT INTO appointment_status_history
            (appointment_id, previous_status, new_status, changed_by)
            VALUES (?, NULL, 'CHAT_STARTED', 'SYSTEM')
            `,
            [appointmentId],
        );
    }

    /* =========================
       Mensaje
    ========================= */
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

    /* =========================
       SOLO HISTORIAL (NO tocar ENUM)
    ========================= */
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

/* ======================================================
   CIERRE FINAL DE CITA
====================================================== */
export async function createFinalAppointment({
    phone,
    fullName,
    date, // DD/MM
    time, // HH:mm
}) {
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

/* ======================================================
   DASHBOARD – CONSULTAS
====================================================== */

export async function getPendingCases() {
    const [rows] = await db.query(`
        SELECT
            a.id AS appointment_id,
            p.full_name,
            p.phone,
            a.status,
            a.updated_at AS last_update
        FROM appointments a
        JOIN patients p ON p.id = a.patient_id
        WHERE a.status IN ('PROPOSED', 'RESCHEDULED')
        ORDER BY a.updated_at DESC
    `);

    return rows;
}

export async function markReScheduled(appointmentId) {
    await db.query(
        "UPDATE appointments SET status = 'RESCHEDULED' WHERE id = ?",
        [appointmentId],
    );
}

export async function confirmAppointment(appointmentId) {
    // 1️⃣ Obtener estado actual
    const [rows] = await db.query(
        "SELECT status FROM appointments WHERE id = ?",
        [appointmentId],
    );

    if (!rows.length) return;

    const previousStatus = rows[0].status;

    // 2️⃣ Actualizar status
    await db.query(
        "UPDATE appointments SET status = 'CONFIRMED' WHERE id = ?",
        [appointmentId],
    );

    // 3️⃣ Guardar en historial
    await db.query(
        `INSERT INTO appointment_status_history
         (appointment_id, previous_status, new_status, changed_by)
         VALUES (?, ?, 'CONFIRMED', 'SYSTEM')`,
        [appointmentId, previousStatus],
    );
}

export async function markCancelled(appointmentId) {
    await db.query(
        "UPDATE appointments SET status = 'CANCELLED' WHERE id = ?",
        [appointmentId],
    );
}
export async function createProposedAppointment({
    phone,
    fullName,
    date,
    time,
}) {
    // 1️⃣ Buscar o crear paciente
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

        // Si llega un nombre real y en BD está vacío/placeholder, actualizamos
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

    // 2️⃣ Convertir fecha
    const [day, month] = date.split("/");
    const year = new Date().getFullYear();
    const scheduledDate = `${year}-${month}-${day}`;

    // 3️⃣ Crear appointment (AQUÍ ESTÁ LA CORRECCIÓN)
    const [appointmentResult] = await db.query(
        `INSERT INTO appointments
         (patient_id, scheduled_date, scheduled_time, status, source)
         VALUES (?, ?, ?, 'PROPOSED', 'BOT')`,
        [patientId, scheduledDate, time],
    );

    const appointmentId = appointmentResult.insertId;

    // 4️⃣ Status history
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
    birthDate = null,
    gender = null,
    habeasData = null,
    rawPayload = null,
}) {
    await db.query(
        `INSERT INTO saludtools_patients
         (saludtools_id, event_type, full_name, birth_date, gender, habeas_data, raw_payload)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
            saludtoolsId || 0,
            eventType,
            fullName || "Paciente WhatsApp",
            birthDate,
            gender,
            habeasData,
            rawPayload ? JSON.stringify(rawPayload) : null,
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
