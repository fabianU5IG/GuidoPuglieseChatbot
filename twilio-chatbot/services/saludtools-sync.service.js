import { db } from "../db/mysql.js";

/**
 * Convierte "2026-03-05 10:00" => { ymd:"2026-03-05", hm:"10:00" }
 */
function splitYmdHm(dateTimeStr) {
  const [ymd, hm] = String(dateTimeStr || "").split(" ");
  return { ymd, hm };
}

/**
 * APPOINTMENT: CREATE/UPDATE desde webhook
 */
export async function syncSaludtoolsAppointment(eventType, payload) {
  try {
    const saludtoolsId = payload?.id;
    if (!saludtoolsId) return;

    const { ymd: startDate, hm: startTime } = splitYmdHm(payload?.startAppointment);
    const { ymd: endDate, hm: endTime } = splitYmdHm(payload?.endAppointment);

    const doctorDoc = payload?.doctorDocumentNumber ?? null;
    const patientDocType = payload?.patientDocumentType ?? null;
    const patientDocNum = payload?.patientDocumentNumber ?? null;
    const status = payload?.stateAppointment ?? null; // PENDING / CANCELLED / etc (según Saludtools)
    const clinic = payload?.clinic ?? null;

    // 1) UPSERT en tabla espejo de saludtools (tu compa ajusta nombre/columnas)
    // EJEMPLO: saludtools_appointments (saludtools_id UNIQUE)
    await db.query(
      `
      INSERT INTO saludtools_appointments
        (saludtools_id, event_type, status, start_date, start_time, end_date, end_time,
         doctor_document_number, patient_document_type, patient_document_number, clinic, raw_payload)
      VALUES
        (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
        raw_payload = VALUES(raw_payload),
        updated_at = NOW()
      `,
      [
        saludtoolsId,
        eventType,
        status,
        startDate,
        startTime,
        endDate,
        endTime,
        doctorDoc,
        patientDocType,
        patientDocNum,
        clinic,
        JSON.stringify(payload),
      ]
    );

    // 2) Si está cancelada, puedes marcar “libre” en tu agenda interna (si tienes tabla slots)
    // if (status === "CANCELLED") { ... }

    return true;
  } catch (err) {
    console.error("❌ syncSaludtoolsAppointment error:", err?.message || err);
    return false;
  }
}

/**
 * PATIENT: CREATE/UPDATE desde webhook
 */
export async function syncSaludtoolsPatient(eventType, payload) {
  try {
    const saludtoolsId = payload?.id;
    const docType = payload?.documentType ?? null;
    const docNum = payload?.documentNumber ?? null;

    if (!saludtoolsId && (!docType || !docNum)) return;

    const fullName = [
      payload?.firstName,
      payload?.secondName,
      payload?.firstLastName,
      payload?.secondLastName,
    ]
      .filter(Boolean)
      .join(" ")
      .trim();

    const habeasData = payload?.habeasData ?? null;
    const birthDate = payload?.birthDate ?? null;
    const gender = payload?.gender ?? null;

    // 1) UPSERT paciente espejo de saludtools
    // EJEMPLO: saludtools_patients (documentType+documentNumber UNIQUE)
    await db.query(
      `
      INSERT INTO saludtools_patients
        (saludtools_id, event_type, document_type, document_number, full_name,
         birth_date, gender, habeas_data, raw_payload)
      VALUES
        (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE
        saludtools_id = VALUES(saludtools_id),
        event_type = VALUES(event_type),
        full_name = VALUES(full_name),
        birth_date = VALUES(birth_date),
        gender = VALUES(gender),
        habeas_data = VALUES(habeas_data),
        raw_payload = VALUES(raw_payload),
        updated_at = NOW()
      `,
      [
        saludtoolsId,
        eventType,
        docType,
        docNum,
        fullName || null,
        birthDate,
        gender,
        habeasData,
        JSON.stringify(payload),
      ]
    );

    // 2) Dirección (si quieren guardarla en tabla aparte)
    // const address = payload?.address;
    // if (address?.id) { upsert address... }

    return true;
  } catch (err) {
    console.error("❌ syncSaludtoolsPatient error:", err?.message || err);
    return false;
  }
}