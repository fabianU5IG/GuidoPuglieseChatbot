import { db } from "../db/mysql.js";

const SESSION_TTL_MINUTES = Math.max(
    5,
    Number(process.env.CHAT_SESSION_TTL_MINUTES || 60),
);

function parseJson(value, fallback = {}) {
    if (!value) return { ...fallback };
    if (typeof value === "object") return value;

    try {
        const parsed = JSON.parse(value);
        return parsed && typeof parsed === "object" ? parsed : { ...fallback };
    } catch {
        return { ...fallback };
    }
}

function pickString(value) {
    return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function pickNumber(value) {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? n : undefined;
}

/**
 * Extrae únicamente los datos de identidad/contacto que vale la pena conservar
 * entre operaciones dentro de la misma sesión. Los datos específicos de una
 * operación (fecha, hora, slots, citas encontradas, etc.) NO van a memoria.
 */
export function extractUserMemory(data = {}) {
    const memory = {};

    const fullName = pickString(data.fullName || data.patientName);
    if (fullName) memory.fullName = fullName;

    const firstName = pickString(data.firstName);
    if (firstName) memory.firstName = firstName;

    const documentType = pickNumber(data.patientDocumentType);
    if (documentType) memory.patientDocumentType = documentType;

    const documentNumber = pickString(
        data.patientDocumentNumber || data.documento,
    );
    if (documentNumber) memory.patientDocumentNumber = documentNumber;

    if (typeof data.patientExistsLocal === "boolean") {
        memory.patientExistsLocal = data.patientExistsLocal;
    }

    const patientStatus = pickString(data.patientStatus);
    if (patientStatus) memory.patientStatus = patientStatus;

    if (data.regPatient && typeof data.regPatient === "object") {
        const regPatient = {};
        const stringFields = [
            "firstName",
            "secondName",
            "firstLastName",
            "secondLastName",
            "birthDate",
            "email",
            "phone",
            "epsName",
        ];

        for (const field of stringFields) {
            const value = pickString(data.regPatient[field]);
            if (value) regPatient[field] = value;
        }

        const gender = pickNumber(data.regPatient.gender);
        if (gender) regPatient.gender = gender;

        if (data.regPatient.eps !== undefined && data.regPatient.eps !== null) {
            const eps = Number(data.regPatient.eps);
            if (Number.isFinite(eps) && eps >= 0) regPatient.eps = eps;
        }

        if (typeof data.regPatient.isParticular === "boolean") {
            regPatient.isParticular = data.regPatient.isParticular;
        }

        if (typeof data.regPatient.habeasData === "boolean") {
            regPatient.habeasData = data.regPatient.habeasData;
        }

        if (Object.keys(regPatient).length) memory.regPatient = regPatient;
    }

    return memory;
}

export function mergeUserMemory(previousMemory = {}, data = {}) {
    const extracted = extractUserMemory(data);

    return {
        ...previousMemory,
        ...extracted,
        regPatient: {
            ...(previousMemory?.regPatient || {}),
            ...(extracted?.regPatient || {}),
        },
    };
}

function isExpired(lastActivityAt) {
    if (!lastActivityAt) return true;

    const last = new Date(lastActivityAt).getTime();
    if (!Number.isFinite(last)) return true;

    return Date.now() - last > SESSION_TTL_MINUTES * 60_000;
}

export async function loadChatSession(phone) {
    const [rows] = await db.query(
        `
        SELECT phone, state, data, memory, last_activity_at
        FROM chat_sessions
        WHERE phone = ?
        LIMIT 1
        `,
        [phone],
    );

    if (!rows.length) {
        return {
            state: "MENU",
            data: {},
            memory: {},
            isNew: true,
        };
    }

    const row = rows[0];

    if (isExpired(row.last_activity_at)) {
        await db.query(
            `
            UPDATE chat_sessions
            SET state = 'MENU',
                data = '{}',
                memory = '{}',
                session_started_at = CURRENT_TIMESTAMP,
                last_activity_at = CURRENT_TIMESTAMP
            WHERE phone = ?
            `,
            [phone],
        );

        return {
            state: "MENU",
            data: {},
            memory: {},
            isNew: true,
        };
    }

    return {
        state: row.state || "MENU",
        data: parseJson(row.data),
        memory: parseJson(row.memory),
        isNew: false,
    };
}

export async function saveChatSession({ phone, state, data = {}, memory = {} }) {
    await db.query(
        `
        INSERT INTO chat_sessions
            (phone, state, data, memory, session_started_at, last_activity_at)
        VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
        ON DUPLICATE KEY UPDATE
            state = VALUES(state),
            data = VALUES(data),
            memory = VALUES(memory),
            last_activity_at = CURRENT_TIMESTAMP
        `,
        [
            phone,
            state || "MENU",
            JSON.stringify(data || {}),
            JSON.stringify(memory || {}),
        ],
    );
}

export async function cleanupExpiredChatSessions() {
    await db.query(
        `
        DELETE FROM chat_sessions
        WHERE last_activity_at < DATE_SUB(CURRENT_TIMESTAMP, INTERVAL ? MINUTE)
        `,
        [SESSION_TTL_MINUTES],
    );
}

export async function clearChatSession(phone) {
    await db.query("DELETE FROM chat_sessions WHERE phone = ?", [phone]);
}

export { SESSION_TTL_MINUTES };
