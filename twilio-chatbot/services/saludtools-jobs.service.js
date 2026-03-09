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
  maxAttempts = 30,
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
