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

export async function isDoctorManuallyBlockedOnYmd(ymd) {
    try {
        const [rows] = await db.query(
            `
            SELECT id
            FROM doctor_unavailability
            WHERE start_date <= ? AND end_date >= ?
            LIMIT 1
            `,
            [ymd, ymd],
        );
        return rows.length > 0;
    } catch (error) {
        // Si la BD falla, se prefiere seguir ofreciendo horarios normales
        // (igual que el resto del bot) en vez de tumbar todo el agendamiento
        // por una consulta que no es la crítica (la de citas ya ocupadas sí
        // se sigue validando aparte).
        console.error(
            "❌ No fue posible consultar bloqueos manuales del doctor:",
            error,
        );
        return false;
    }
}

/**
 * Devuelve los bloques de atención reales de un día ("YYYY-MM-DD"): un
 * arreglo vacío significa que no hay atención (no le toca ese día de la
 * semana, es festivo, o la secretaria lo bloqueó manualmente).
 */
export async function getScheduleBlocksForYmd(ymd) {
    if (isHoliday(ymd)) return [];

    const dow = new Date(`${ymd}T00:00:00`).getDay();
    const blocks = WEEKLY_SCHEDULE[dow];
    if (!blocks) return [];

    if (await isDoctorManuallyBlockedOnYmd(ymd)) return [];

    return blocks;
}

export async function addDoctorUnavailability({
    startDate,
    endDate = null,
    reason = null,
    createdBy = null,
}) {
    await db.query(
        `
        INSERT INTO doctor_unavailability (start_date, end_date, reason, created_by)
        VALUES (?, ?, ?, ?)
        `,
        [startDate, endDate || startDate, reason, createdBy],
    );
}

export async function getUpcomingDoctorUnavailability() {
    const [rows] = await db.query(
        `
        SELECT id, start_date, end_date, reason, created_by, created_at
        FROM doctor_unavailability
        WHERE end_date >= CURDATE()
        ORDER BY start_date ASC
        `,
    );
    return rows;
}
