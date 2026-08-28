import { db } from "../db/mysql.js";

function parsePayload(job) {
  if (!job) return null;
  return {
    ...job,
    payload:
      typeof job.payload === "string"
        ? JSON.parse(job.payload)
        : job.payload,
  };
}

export async function createSaludtoolsJob({
  jobType,
  phone,
  appointmentId = null,
  dedupeKey = null,
  payload,
  priority = 100,
  // Con el backoff creciente del worker (computeRetryDelaySeconds), 60
  // intentos cubren cerca de 12 horas de reintentos antes de rendirse —
  // antes eran 30 intentos a 60s fijos (~30 min), muy corto para un corte
  // largo de Saludtools como el que ya se vio en producción.
  maxAttempts = 60,
}) {
  const [result] = await db.query(
    `
      INSERT INTO saludtools_jobs
        (job_type, status, priority, phone, appointment_id, dedupe_key, payload, attempts, max_attempts, next_run_at)
      VALUES
        (?, 'PENDING', ?, ?, ?, ?, ?, 0, ?, NOW())
      ON DUPLICATE KEY UPDATE
        updated_at = CURRENT_TIMESTAMP,
        id = LAST_INSERT_ID(id)
    `,
    [
      jobType,
      priority,
      phone,
      appointmentId,
      dedupeKey,
      JSON.stringify(payload),
      maxAttempts,
    ],
  );

  return result.insertId;
}

export async function pickNextSaludtoolsJob() {
  const conn = await db.getConnection();

  try {
    await conn.beginTransaction();

    const [rows] = await conn.query(
      `
        SELECT *
        FROM saludtools_jobs
        WHERE status IN ('PENDING', 'RETRY')
          AND next_run_at <= NOW()
        ORDER BY priority ASC, id ASC
        LIMIT 1
        FOR UPDATE
      `,
    );

    if (!rows.length) {
      await conn.commit();
      return null;
    }

    const job = rows[0];

    await conn.query(
      `
        UPDATE saludtools_jobs
        SET status = 'PROCESSING',
            attempts = attempts + 1,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `,
      [job.id],
    );

    await conn.commit();
    job.attempts = Number(job.attempts || 0) + 1;
    return parsePayload(job);
  } catch (error) {
    await conn.rollback();
    throw error;
  } finally {
    conn.release();
  }
}

export async function markSaludtoolsJobDone(jobId, externalId = null) {
  await db.query(
    `
      UPDATE saludtools_jobs
      SET status = 'DONE',
          external_id = ?,
          last_error = NULL,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `,
    [externalId, jobId],
  );
}

export async function markSaludtoolsJobRetry(jobId, lastError, delaySeconds = 60) {
  await db.query(
    `
      UPDATE saludtools_jobs
      SET status = 'RETRY',
          last_error = ?,
          next_run_at = DATE_ADD(NOW(), INTERVAL ? SECOND),
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `,
    [String(lastError || "Retry").slice(0, 4000), delaySeconds, jobId],
  );
}

export async function markSaludtoolsJobFailed(jobId, lastError) {
  await db.query(
    `
      UPDATE saludtools_jobs
      SET status = 'FAILED',
          last_error = ?,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `,
    [String(lastError || "Failed").slice(0, 4000), jobId],
  );
}

export async function getSaludtoolsJobById(jobId) {
  const [rows] = await db.query(`SELECT * FROM saludtools_jobs WHERE id = ? LIMIT 1`, [jobId]);
  return parsePayload(rows[0] || null);
}

// Jobs que agotaron todos sus reintentos: antes no había ninguna forma de
// verlos salvo consultando la tabla a mano — quedaban invisibles para la
// secretaria aunque la cita nunca hubiera llegado a Saludtools.
export async function getRecentFailedSaludtoolsJobs(limit = 15) {
  const [rows] = await db.query(
    `
      SELECT id, job_type, phone, appointment_id, payload, attempts, last_error, updated_at
      FROM saludtools_jobs
      WHERE status = 'FAILED'
      ORDER BY updated_at DESC
      LIMIT ?
    `,
    [Number(limit) || 15],
  );

  return rows.map((row) => parsePayload(row));
}

// Vuelve a poner un job FAILED en la cola (attempts en 0, para que tenga de
// nuevo todo el presupuesto de reintentos) para que el worker lo recoja en
// su próxima vuelta. Devuelve false si el job ya no está en FAILED (ej: se
// resolvió solo, o ya lo reintentó otra persona).
export async function retrySaludtoolsJob(jobId) {
  const [result] = await db.query(
    `
      UPDATE saludtools_jobs
      SET status = 'PENDING',
          attempts = 0,
          last_error = NULL,
          next_run_at = NOW(),
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND status = 'FAILED'
    `,
    [jobId],
  );

  return result.affectedRows > 0;
}
