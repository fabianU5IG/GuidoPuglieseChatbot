import { db } from "../db/mysql.js";
import { searchAppointmentsByPatientInSaludtools } from "./saludtools-api.service.js";

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
    // El evento DELETE de Saludtools cancela la cita; a veces el payload no
    // trae stateAppointment actualizado, así que se fuerza aquí para no
    // depender de que Saludtools lo mande correcto.
    const status =
      eventType === "DELETE"
        ? "CANCELLED"
        : (payload?.stateAppointment ?? null); // PENDING / CANCELLED / etc (según Saludtools)
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

    // DELETE: se borra la fila espejo en vez de actualizarla. En el resto
    // del código, "existe una fila en saludtools_patients" se usa como
    // equivalente a "el paciente existe en Saludtools" (ver
    // findSaludtoolsPatientInDb en agendar.state.js/soporteCita.state.js),
    // así que dejar la fila desactualizada haría que el bot siguiera
    // creyendo que el paciente existe después de eliminado.
    if (eventType === "DELETE") {
      if (saludtoolsId) {
        await db.query(
          "DELETE FROM saludtools_patients WHERE saludtools_id = ?",
          [saludtoolsId],
        );
      } else {
        await db.query(
          "DELETE FROM saludtools_patients WHERE document_type = ? AND document_number = ?",
          [docType, docNum],
        );
      }
      return true;
    }

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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * El bot no recibe aviso de Saludtools cuando algo cambia allá directamente
 * (una cita se cancela, alguien bloquea un horario, etc.), porque el webhook
 * de entrada (/webhook/saludtools/*) nunca ha recibido una sola llamada real
 * — nadie lo configuró del lado de Saludtools. Mientras eso no se resuelva,
 * esto revisa periódicamente el estado REAL de las citas que ya conocemos
 * localmente y corrige nuestra copia si quedó desactualizada. Se confirmó
 * en producción: una cita cancelada en Saludtools seguía como "PENDING" en
 * la copia local, y el bot la seguía mostrando como horario ocupado a los
 * pacientes.
 *
 * Deliberadamente NO hace una búsqueda amplia por rango de fechas (eso
 * disparó un 429 de Saludtools al probarlo) — solo re-verifica, una por
 * una, las citas que YA tenemos guardadas y que todavía no están canceladas.
 * Esto no detecta citas/bloqueos creados en Saludtools que el bot nunca ha
 * visto (eso requeriría una búsqueda amplia, pendiente de afinar por el
 * límite de tasa).
 */
export async function reconcileKnownSaludtoolsAppointments({
  limit = 30,
  delayMs = 400,
} = {}) {
  const [rows] = await db.query(
    `
    SELECT saludtools_id, status, patient_document_type, patient_document_number
    FROM saludtools_appointments
    WHERE start_date >= CURDATE()
      AND status NOT IN ('CANCELLED', 'CANCELED')
      AND patient_document_number IS NOT NULL
    ORDER BY start_date ASC, start_time ASC
    LIMIT ?
    `,
    [limit],
  );

  let checked = 0;
  let changed = 0;

  for (const row of rows) {
    checked += 1;

    try {
      const resp = await searchAppointmentsByPatientInSaludtools({
        patientDocumentType: row.patient_document_type,
        patientDocumentNumber: row.patient_document_number,
        page: 0,
        size: 20,
      });

      const content = resp?.body?.content || resp?.content || [];
      const match = Array.isArray(content)
        ? content.find(
            (item) => String(item?.id) === String(row.saludtools_id),
          )
        : null;

      if (match && String(match.stateAppointment) !== String(row.status)) {
        const updated = await syncSaludtoolsAppointment(
          "RECONCILE_STATUS_CHANGE",
          match,
        );
        if (updated) {
          changed += 1;
          console.log(
            `🔄 Cita ${row.saludtools_id} desactualizada: local=${row.status} -> real=${match.stateAppointment}`,
          );
        }
      }
    } catch (error) {
      console.error(
        `⚠️ No se pudo reconciliar la cita ${row.saludtools_id}:`,
        error?.message || error,
      );
    }

    // Este mismo endpoint ya nos dio un 429 al llamarlo muy seguido en
    // pruebas manuales; se espacían las consultas para no repetirlo.
    if (delayMs) await sleep(delayMs);
  }

  return { checked, changed };
}

/**
 * Punto de partida para "cómo bloquear un horario": Saludtools exige un
 * paciente para crear cualquier cosa (ni el bloqueo más simple puede
 * quedar sin uno), y la búsqueda amplia por rango de fechas del doctor no
 * sirve para descubrir cosas nuevas (Saludtools la devuelve vacía aunque
 * haya citas reales en el rango — probablemente un límite/bug de su lado).
 * La búsqueda por documento de paciente sí es confiable.
 *
 * Por eso: si el equipo registra en Saludtools un paciente reservado para
 * bloqueos (ej. "BLOQUEO CONSULTORIO") y configura su documento aquí
 * (SALUDTOOLS_BLOCK_DOCUMENT_TYPE / SALUDTOOLS_BLOCK_DOCUMENT_NUMBER), esta
 * función busca periódicamente las citas de ESE paciente y las trae a la
 * copia local — así cualquier horario bloqueado directamente en Saludtools
 * para ese paciente deja de mostrarse como disponible en el bot.
 *
 * Sin configurar, no hace nada (no cambia el comportamiento actual).
 */
export async function discoverSaludtoolsBlocks({ limit = 19 } = {}) {
  const documentType = Number(process.env.SALUDTOOLS_BLOCK_DOCUMENT_TYPE || 0);
  const documentNumber = String(
    process.env.SALUDTOOLS_BLOCK_DOCUMENT_NUMBER || "",
  ).trim();

  if (!documentType || !documentNumber) {
    return { configured: false, checked: 0, found: 0 };
  }

  try {
    const resp = await searchAppointmentsByPatientInSaludtools({
      patientDocumentType: documentType,
      patientDocumentNumber: documentNumber,
      page: 0,
      size: Math.min(Math.max(1, limit), 19),
    });

    const content = resp?.body?.content || resp?.content || [];
    let found = 0;

    for (const item of Array.isArray(content) ? content : []) {
      const ok = await syncSaludtoolsAppointment("BLOCK_DISCOVERY", item);
      if (ok) found += 1;
    }

    return {
      configured: true,
      checked: Array.isArray(content) ? content.length : 0,
      found,
    };
  } catch (error) {
    console.error(
      "❌ discoverSaludtoolsBlocks error:",
      error?.message || error,
    );
    return { configured: true, checked: 0, found: 0, error: error.message };
  }
}