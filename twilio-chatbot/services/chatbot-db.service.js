import { db } from "../db/mysql.js";

/* ======================================================
   UTILIDAD BASE – Paciente
====================================================== */
async function getOrCreatePatient(phone, fullName = null) {
    const [p] = await db.query("SELECT id FROM patients WHERE phone = ?", [
        phone,
    ]);

    if (p.length) return p[0].id;

    const [r] = await db.query(
        "INSERT INTO patients (phone, full_name) VALUES (?, ?)",
        [phone, fullName],
    );

    return r.insertId;
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

export async function markCancelled(appointmentId) {
    await db.query(
        "UPDATE appointments SET status = 'CANCELLED' WHERE id = ?",
        [appointmentId],
    );
}
export async function createProposedAppointment({
    phone,
    fullName,
    date, // DD/MM
    time, // HH:mm
}) {
    // 1. Buscar o crear paciente
    const [patient] = await db.query(
        `SELECT id FROM patients WHERE phone = ?`,
        [phone],
    );

    let patientId;

    if (patient.length) {
        patientId = patient[0].id;
    } else {
        const result = await db.query(
            `INSERT INTO patients (full_name, phone) VALUES (?, ?)`,
            [fullName, phone],
        );
        patientId = result.insertId;
    }

    // 2. Convertir fecha
    const [day, month] = date.split("/");
    const year = new Date().getFullYear();
    const scheduledDate = `${year}-${month}-${day}`;

    // 3. Crear appointment
    const appointmentResult = await db.query(
        `INSERT INTO appointments
         (patient_id, scheduled_date, scheduled_time, status, source)
         VALUES (?, ?, ?, 'PROPOSED', 'BOT')`,
        [patientId, scheduledDate, time],
    );

    const appointmentId = appointmentResult.insertId;

    // 4. Status history
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
