import { db } from "../db/mysql.js";

/**
 * Festivos Colombia 2026.
 *
 * Centralizado aquí (antes estaba duplicado en agendar.state.js y
 * soporteCita.state.js) porque ahora el horario también depende de una
 * tabla en BD (doctor_unavailability): tener dos copias de esta regla
 * corría el riesgo de que agendar y reagendar/cancelar terminaran viendo
 * disponibilidad distinta para el mismo día.
 */
const HOLIDAYS_2026 = [
    "2026-01-01", "2026-01-12", "2026-03-23", "2026-04-02", "2026-04-03",
    "2026-05-01", "2026-05-18", "2026-06-08", "2026-06-15", "2026-06-29",
    "2026-07-20", "2026-08-07", "2026-08-17", "2026-10-12", "2026-11-02",
    "2026-11-16", "2026-12-08", "2026-12-25",
];

export function isHoliday(ymd) {
    return HOLIDAYS_2026.includes(ymd);
}

// Bloques reales de atención por día de la semana (0=domingo...6=sábado).
// Lunes/martes/jueves tienen descanso de mediodía; viernes es solo mañana;
// miércoles, sábado y domingo no atiende (sin entrada = cerrado).
const WEEKLY_SCHEDULE = {
    1: [
        { start: "08:00", end: "12:00" },
        { start: "14:00", end: "17:00" },
    ],
    2: [
        { start: "08:00", end: "12:00" },
        { start: "14:00", end: "17:00" },
    ],
    4: [
        { start: "08:00", end: "12:00" },
        { start: "14:00", end: "17:00" },
    ],
    5: [{ start: "08:30", end: "12:00" }],
};

function timeToMinutes(hm) {
    const [h, m] = String(hm).slice(0, 5).split(":").map(Number);
    return h * 60 + m;
}

function minutesToTime(mins) {
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

// Recorta un bloque de atención según un rango bloqueado, partiéndolo en dos
// si el bloqueo cae en medio (ej: bloque 08:00-17:00 menos 12:00-13:00 da
// [08:00-12:00, 13:00-17:00]).
function subtractRangeFromBlocks(blocks, blockedStartHm, blockedEndHm) {
    const blockedStart = timeToMinutes(blockedStartHm);
    const blockedEnd = timeToMinutes(blockedEndHm);
    const result = [];

    for (const block of blocks) {
        const start = timeToMinutes(block.start);
        const end = timeToMinutes(block.end);

        if (blockedEnd <= start || blockedStart >= end) {
            result.push(block);
            continue;
        }

        if (blockedStart > start) {
            result.push({ start: block.start, end: minutesToTime(Math.min(blockedStart, end)) });
        }
        if (blockedEnd < end) {
            result.push({ start: minutesToTime(Math.max(blockedEnd, start)), end: block.end });
        }
    }

    return result;
}

async function getDoctorUnavailabilityForYmd(ymd) {
    try {
        const [rows] = await db.query(
            `
            SELECT start_time, end_time
            FROM doctor_unavailability
            WHERE start_date <= ? AND end_date >= ?
            `,
            [ymd, ymd],
        );
        return rows;
    } catch (error) {
        // Si la BD falla, se prefiere seguir ofreciendo horarios normales
        // (igual que el resto del bot) en vez de tumbar todo el agendamiento
        // por una consulta que no es la crítica (la de citas ya ocupadas sí
        // se sigue validando aparte).
        console.error(
            "❌ No fue posible consultar bloqueos manuales del doctor:",
            error,
        );
        return [];
    }
}

/**
 * Devuelve los bloques de atención reales de un día ("YYYY-MM-DD"): un
 * arreglo vacío significa que no hay atención (no le toca ese día de la
 * semana, es festivo, o la secretaria lo bloqueó manualmente todo el día).
 * Si la secretaria solo bloqueó un rango de horas (ej: "de 8 a 9"), se
 * recortan únicamente esas horas y el resto del día sigue disponible.
 */
export async function getScheduleBlocksForYmd(ymd) {
    if (isHoliday(ymd)) return [];

    const dow = new Date(`${ymd}T00:00:00`).getDay();
    let blocks = WEEKLY_SCHEDULE[dow];
    if (!blocks) return [];

    const unavailableRanges = await getDoctorUnavailabilityForYmd(ymd);

    for (const range of unavailableRanges) {
        const isWholeDay = !range.start_time || !range.end_time;
        if (isWholeDay) return [];

        blocks = subtractRangeFromBlocks(blocks, range.start_time, range.end_time);
    }

    return blocks;
}

export async function addDoctorUnavailability({
    startDate,
    endDate = null,
    startTime = null,
    endTime = null,
    reason = null,
    createdBy = null,
}) {
    await db.query(
        `
        INSERT INTO doctor_unavailability
            (start_date, end_date, start_time, end_time, reason, created_by)
        VALUES (?, ?, ?, ?, ?, ?)
        `,
        [startDate, endDate || startDate, startTime, endTime, reason, createdBy],
    );
}

// Quita cualquier bloqueo que incluya esa fecha (día completo o por horas).
// Simplificación deliberada: si el bloqueo era un rango de varios días (ej:
// "del 10 al 12"), pedir "desbloquea el 11" borra el rango completo en vez
// de recortarlo — es el caso normal (un bloqueo por vez) el que importa hoy.
export async function removeDoctorUnavailabilityForYmd(ymd) {
    const [result] = await db.query(
        `
        DELETE FROM doctor_unavailability
        WHERE start_date <= ? AND end_date >= ?
        `,
        [ymd, ymd],
    );
    return result.affectedRows;
}

export async function getUpcomingDoctorUnavailability() {
    const [rows] = await db.query(
        `
        SELECT id, start_date, end_date, start_time, end_time, reason, created_by, created_at
        FROM doctor_unavailability
        WHERE end_date >= CURDATE()
        ORDER BY start_date ASC
        `,
    );
    return rows;
}
