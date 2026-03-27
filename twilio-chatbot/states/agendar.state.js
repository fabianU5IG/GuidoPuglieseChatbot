import {
    createProposedAppointment,
    logAppointmentMessage,
    upsertPatientName,
    updateAppointmentStatusById,
} from "../services/chatbot-db.service.js";
import { createSaludtoolsJob } from "../services/saludtools-jobs.service.js";
import { EPS_CONVENIO } from "../constants.js";
import { db } from "../db/mysql.js";

const DOCTOR_DOCUMENT_TYPE = Number(
    process.env.SALUDTOOLS_DOCTOR_DOCUMENT_TYPE || 1,
);
const DOCTOR_DOCUMENT_NUMBER =
    process.env.SALUDTOOLS_DOCTOR_DOCUMENT_NUMBER || "72134079";
const CLINIC_ID = Number(process.env.SALUDTOOLS_CLINIC_ID || 18569);

const APPOINTMENT_DURATION_MIN = 20;
const APPOINTMENT_MODALITY =
    process.env.SALUDTOOLS_APPOINTMENT_MODALITY || "CONVENTIONAL";
const APPOINTMENT_STATE = process.env.SALUDTOOLS_APPOINTMENT_STATE || "PENDING";
const APPOINTMENT_TYPE_DEFAULT =
    process.env.SALUDTOOLS_APPOINTMENT_TYPE || "Pruebas Luis";

const SALUDTOOLS_DEBUG =
    String(process.env.SALUDTOOLS_DEBUG || "").toLowerCase() === "true" ||
    process.env.SALUDTOOLS_DEBUG === "1";

function returnToMenu() {
    return { response: null, nextState: "MENU", data: { renderMenu: true } };
}

function normKey(s) {
    return String(s || "")
        .trim()
        .toLowerCase();
}

function normalizeDocType(msg) {
    const v = String(msg || "")
        .trim()
        .toLowerCase();
    if (v === "1" || v === "cc") return 1;
    if (v === "2" || v === "ce") return 2;
    return null;
}

function parsePhoneE164ToDigits(phone) {
    const digits = String(phone || "").replace(/\D/g, "");
    if (digits.startsWith("57") && digits.length >= 12) return digits.slice(2);
    return digits;
}

function splitName(fullName = "") {
    const parts = String(fullName).trim().split(/\s+/).filter(Boolean);

    if (parts.length === 0) {
        return {
            firstName: "",
            secondName: "",
            firstLastName: "",
            secondLastName: "",
        };
    }

    if (parts.length === 1) {
        return {
            firstName: parts[0],
            secondName: "",
            firstLastName: "",
            secondLastName: "",
        };
    }

    if (parts.length === 2) {
        return {
            firstName: parts[0],
            secondName: "",
            firstLastName: parts[1],
            secondLastName: "",
        };
    }

    if (parts.length === 3) {
        return {
            firstName: parts[0],
            secondName: parts[1],
            firstLastName: parts[2],
            secondLastName: "",
        };
    }

    return {
        firstName: parts[0],
        secondName: parts.slice(1, parts.length - 2).join(" "),
        firstLastName: parts[parts.length - 2],
        secondLastName: parts[parts.length - 1],
    };
}

/**
 * Festivos Colombia 2026
 */
function isHoliday(ymd) {
    const holidays = [
        // 2026
        "2026-01-01", "2026-01-12", "2026-03-23", "2026-04-02", "2026-04-03",
        "2026-05-01", "2026-05-18", "2026-06-08", "2026-06-15", "2026-06-29",
        "2026-07-20", "2026-08-07", "2026-08-17", "2026-10-12", "2026-11-02",
        "2026-11-16", "2026-12-08", "2026-12-25"
    ];
    return holidays.includes(ymd);
}

function isValidDateDDMM(value) {
    if (!/^\d{2}\/\d{2}$/.test(value)) return false;

    const [day, month] = value.split("/").map(Number);
    const year = new Date().getFullYear();
    const date = new Date(year, month - 1, day);

    // El Dr. requiere al menos 2 días de anticipación (T+2)
    const minDate = new Date();
    minDate.setHours(0, 0, 0, 0);
    minDate.setDate(minDate.getDate() + 2);

    return !isNaN(date.getTime()) && date >= minDate;
}

function ddmmToYmd(ddmm) {
    const [day, month] = ddmm.split("/").map(Number);
    const year = new Date().getFullYear();
    const d = new Date(year, month - 1, day);
    const yyyy = String(d.getFullYear()).padStart(4, "0");
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    const dd = String(d.getDate()).padStart(2, "0");
    return `${yyyy}-${mm}-${dd}`;
}

function addMinutesToYmdHm(ymd, hm, minutesToAdd) {
    const [H, M] = hm.split(":").map(Number);
    const [Y, Mo, D] = ymd.split("-").map(Number);
    const dt = new Date(Y, Mo - 1, D, H, M, 0, 0);
    dt.setMinutes(dt.getMinutes() + minutesToAdd);

    const yyyy = String(dt.getFullYear()).padStart(4, "0");
    const mm = String(dt.getMonth() + 1).padStart(2, "0");
    const dd = String(dt.getDate()).padStart(2, "0");
    const hh = String(dt.getHours()).padStart(2, "0");
    const min = String(dt.getMinutes()).padStart(2, "0");

    return { ymd: `${yyyy}-${mm}-${dd}`, hm: `${hh}:${min}` };
}

function isValidBirthDateYmd(value) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const d = new Date(value + "T00:00:00");
    return !isNaN(d.getTime());
}

function normalizeEmail(value) {
    const s = String(value || "").trim();
    if (!s) return "";
    const ok = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
    return ok ? s : null;
}

function isCancelledStatus(status) {
    const s = String(status || "").toUpperCase();
    return s === "CANCELLED" || s === "CANCELED";
}

async function findSaludtoolsPatientInDb({ docType, docNum }) {
    const [rows] = await db.query(
        `
        SELECT saludtools_id, full_name, document_type, document_number
        FROM saludtools_patients
        WHERE document_type = ?
          AND document_number = ?
        LIMIT 1
        `,
        [Number(docType), String(docNum)],
    );

    return rows?.[0] || null;
}

async function getBookedHmFromDb({ ymd, doctorDoc }) {
    const [rows] = await db.query(
        `
        SELECT start_time, status
        FROM saludtools_appointments
        WHERE start_date = ?
          AND doctor_document_number = ?
        `,
        [ymd, String(doctorDoc)],
    );

    if (!Array.isArray(rows) || !rows.length) return [];

    return rows
        .filter((r) => !isCancelledStatus(r.status))
        .map((r) => String(r.start_time).slice(0, 5));
}

async function isSlotBookedInDb({ ymd, hm, doctorDoc }) {
    const [rows] = await db.query(
        `
        SELECT status
        FROM saludtools_appointments
        WHERE start_date = ?
          AND start_time = ?
          AND doctor_document_number = ?
        LIMIT 1
        `,
        [ymd, `${hm}:00`, String(doctorDoc)],
    );

    if (!rows.length) return false;
    return !isCancelledStatus(rows[0].status);
}

const ALLOWED_DOC_TYPES = new Set([1, 2]);
const ALLOWED_GENDERS = new Set([1, 2]);

function collapseSpaces(s) {
    return String(s || "")
        .replace(/\s+/g, " ")
        .trim();
}

function sanitizeName(s) {
    const v = collapseSpaces(s);
    const cleaned = v.replace(/[^A-Za-zÁÉÍÓÚÜÑáéíóúüñ\s'-]/g, "");
    return collapseSpaces(cleaned);
}

function isValidDigits(str, min, max) {
    const v = String(str || "");
    if (!/^\d+$/.test(v)) return false;
    return v.length >= min && v.length <= max;
}

function isValidPhoneDigits(v) {
    return isValidDigits(v, 7, 15);
}

function validateAndNormalizePatientBody(patientBody) {
    const b = { ...patientBody };

    b.firstName = sanitizeName(b.firstName);
    b.secondName = sanitizeName(b.secondName);
    b.firstLastName = sanitizeName(b.firstLastName);
    b.secondLastName = sanitizeName(b.secondLastName);

    b.gender = Number(b.gender);
    b.documentType = Number(b.documentType);

    b.documentNumber = String(b.documentNumber || "").trim();
    b.birthDate = String(b.birthDate || "").trim();
    b.email = String(b.email || "").trim();

    b.phone = String(b.phone || "").trim();
    b.cellPhone = String(b.cellPhone || "").trim();

    const epsNum = Number(b.eps || 0);
    b.eps = Number.isFinite(epsNum) && epsNum > 0 ? epsNum : 0;

    b.habeasData = Boolean(b.habeasData);

    if (!b.firstName || b.firstName.length < 2) {
        return {
            ok: false,
            step: "REG_FIRSTNAME",
            message: "Primer nombre inválido. Escríbelo nuevamente:",
        };
    }
    if (!b.firstLastName || b.firstLastName.length < 2) {
        return {
            ok: false,
            step: "REG_FIRSTLASTNAME",
            message: "Primer apellido inválido. Escríbelo nuevamente:",
        };
    }

    if (!isValidBirthDateYmd(b.birthDate)) {
        return {
            ok: false,
            step: "REG_BIRTHDATE",
            message: "Fecha inválida. Usa YYYY-MM-DD. Ej: 1967-12-05",
        };
    }

    if (!ALLOWED_GENDERS.has(b.gender)) {
        return {
            ok: false,
            step: "REG_GENDER",
            message: "Elige 1 o 2, o 0 para volver al menú.",
        };
    }

    if (!ALLOWED_DOC_TYPES.has(b.documentType)) {
        return {
            ok: false,
            step: "ASK_DOC_TYPE",
            message:
                "Selecciona tu tipo de documento:\n\n1️⃣ CC\n2️⃣ CE\n\n0️⃣ Volver al menú",
        };
    }

    if (!isValidDigits(b.documentNumber, 5, 20)) {
        return {
            ok: false,
            step: "ASK_DOC_NUMBER",
            message:
                "Número inválido. Por favor escribe solo números (mínimo 5 dígitos):",
        };
    }

    if (!isValidPhoneDigits(b.phone) || !isValidPhoneDigits(b.cellPhone)) {
        return {
            ok: false,
            step: "REG_HABEAS",
            message:
                "No pude validar el número de contacto. Intentemos nuevamente la confirmación de datos (Habeas Data):\n\n1️⃣ Sí, autorizo\n2️⃣ No autorizo\n\n0️⃣ Volver al menú",
        };
    }

    if (b.email) {
        const em = normalizeEmail(b.email);
        if (em === null) {
            return {
                ok: false,
                step: "REG_EMAIL",
                message: "Correo inválido. Intenta de nuevo o escribe 0:",
            };
        }
        b.email = em;
    } else {
        b.email = "";
    }

    return { ok: true, body: b };
}

const SLOT_MIN = 20;

function pad2(n) {
    return String(n).padStart(2, "0");
}

function buildSlots(startHm, endHm, slotMin = SLOT_MIN) {
    const [sh, sm] = startHm.split(":").map(Number);
    const [eh, em] = endHm.split(":").map(Number);

    const startTotal = sh * 60 + sm;
    const endTotal = eh * 60 + em;

    const lastStart = endTotal - slotMin;
    const slots = [];

    for (let t = startTotal; t <= lastStart; t += slotMin) {
        const h = Math.floor(t / 60);
        const m = t % 60;
        slots.push(`${pad2(h)}:${pad2(m)}`);
    }
    return slots;
}

function getScheduleForYmd(ymd) {
    if (isHoliday(ymd)) return null;

    const d = new Date(`${ymd}T00:00:00`);
    const dow = d.getDay();

    // Lunes (1), Martes (2), Jueves (4)
    if (dow === 1 || dow === 2 || dow === 4)
        return { start: "08:00", end: "17:30" };
    // Viernes (5)
    if (dow === 5) return { start: "08:30", end: "11:30" };

    // Miércoles (3), Sábado (6) y Domingo (0) no atiende
    return null;
}

function getSlotsForDate(ymd, page = 0) {
    const schedule = getScheduleForYmd(ymd);
    if (!schedule) return [];

    const all = buildSlots(schedule.start, schedule.end, SLOT_MIN);
    const pageSize = 6;
    const from = page * pageSize;
    return all.slice(from, from + pageSize);
}

function buildTimeResponse(data) {
    const ymd = data.ymd;
    const slotsAll = getSlotsForDate(ymd, data.page || 0);

    if (!slotsAll.length) {
        return {
            response:
                `El Dr. no tiene atención el día ${data.date}.\n\n` +
                "Escribe otra fecha (DD/MM) o 0 para volver al menú.",
            nextState: "AGENDAR",
            data,
        };
    }

    const booked = new Set(Array.isArray(data.bookedHm) ? data.bookedHm : []);
    const slots = slotsAll.filter((h) => !booked.has(h));
    data.visibleSlots = slots;

    if (!slots.length) {
        return {
            response:
                `No veo horarios disponibles para ${data.date} en esta página.\n\n` +
                "7️⃣ Ver más horarios\n" +
                "También puedes escribir otra fecha en formato DD/MM.\n\n" +
                "0️⃣ Volver al menú",
            nextState: "AGENDAR",
            data,
        };
    }

    let response = `Horas disponibles para ${data.date}:\n\n`;
    slots.forEach((h, i) => {
        response += `${i + 1}️⃣ ${h}\n`;
    });
    response += "\n7️⃣ Más horarios\n";
    response += "También puedes escribir otra fecha en formato DD/MM.\n";
    response += "0️⃣ Volver al menú";

    return { response, nextState: "AGENDAR", data };
}

function capitalize(str) {
    if (!str) return "";
    return String(str)
        .trim()
        .split(/\s+/)
        .map(
            (word) =>
                word.charAt(0).toUpperCase() + word.slice(1).toLowerCase(),
        )
        .join(" ");
}

export default async function agendarState(msg, data, context = {}) {
    const phone = context.from || "UNKNOWN";

    if (!data.step) {
        data.step = "ASK_NAME";
        return {
            response:
                "Vamos a iniciar el agendamiento.\n\n¿Cuál es tu nombre completo?",
            nextState: "AGENDAR",
            data,
        };
    }

    switch (data.step) {
        case "ASK_NAME": {
            if (!msg || msg.trim().length < 3) {
                return {
                    response: "Por favor ingresa tu nombre completo.",
                    nextState: "AGENDAR",
                    data,
                };
            }

            data.fullName = capitalize(msg);
            const split = splitName(data.fullName);
            data.firstName = capitalize(split.firstName);

            try {
                await upsertPatientName(phone, data.fullName);
            } catch { }

            data.step = "ASK_DOC_TYPE";
            return {
                response:
                    `Gracias, ${data.firstName}.\n\n` +
                    "Para crear tu cita necesito tu tipo de documento:\n\n" +
                    "1️⃣ CC\n" +
                    "2️⃣ CE\n\n" +
                    "0️⃣ Volver al menú",
                nextState: "AGENDAR",
                data,
            };
        }

        case "ASK_DOC_TYPE": {
            if (msg === "0") return returnToMenu();

            const t = normalizeDocType(msg);
            if (!t) {
                return {
                    response:
                        "Selecciona una opción válida:\n\n" +
                        "1️⃣ CC\n" +
                        "2️⃣ CE\n\n" +
                        "0️⃣ Volver al menú",
                    nextState: "AGENDAR",
                    data,
                };
            }

            data.patientDocumentType = t;
            data.step = "ASK_DOC_NUMBER";
            return {
                response: "Escribe tu número de documento (solo números):",
                nextState: "AGENDAR",
                data,
            };
        }

        case "ASK_DOC_NUMBER": {
            if (msg === "0") return returnToMenu();

            const doc = String(msg || "").trim();
            if (!/^\d{5,20}$/.test(doc)) {
                return {
                    response:
                        "Número inválido. Por favor escribe solo números (mínimo 5 dígitos):",
                    nextState: "AGENDAR",
                    data,
                };
            }

            data.patientDocumentType = Number(data.patientDocumentType);
            data.patientDocumentNumber = doc;

            try {
                const local = await findSaludtoolsPatientInDb({
                    docType: data.patientDocumentType,
                    docNum: data.patientDocumentNumber,
                });

                if (local) {
                    data.patientExistsLocal = true;
                    data.patientStatus = "ACTIVE";
                    data.step = "FILTRO_COLUMNA";

                    return {
                        response:
                            "Perfecto, ya encontré tu registro.\n\n" +
                            "¿Tu consulta está relacionada con dolor lumbar, cervical o problemas de columna?\n\n" +
                            "1️⃣ Sí\n" +
                            "2️⃣ No\n\n" +
                            "0️⃣ Volver al menú",
                        nextState: "AGENDAR",
                        data,
                    };
                }
            } catch (e) {
                if (SALUDTOOLS_DEBUG) {
                    console.error("findSaludtoolsPatientInDb error", e);
                }
            }

            data.patientExistsLocal = false;

            const parts = splitName(data.fullName || "");
            data.regPatient = {
                firstName: parts.firstName || "",
                secondName: parts.secondName || "",
                firstLastName: parts.firstLastName || "",
                secondLastName: parts.secondLastName || "",
                birthDate: "",
                gender: null,
                email: "",
                eps: "",
                habeasData: false,
            };

            data.step = "REG_CONFIRM_NAMES";
            return {
                response:
                    "No encontré tu registro local. Vamos a registrarte antes de agendar.\n\n" +
                    `Tengo estos datos de tu nombre:\n` +
                    `• Primer nombre: ${capitalize(data.regPatient.firstName) || "(vacío)"}\n` +
                    `• Segundo nombre: ${capitalize(data.regPatient.secondName) || "(vacío)"}\n` +
                    `• Primer apellido: ${capitalize(data.regPatient.firstLastName) || "(vacío)"}\n` +
                    `• Segundo apellido: ${capitalize(data.regPatient.secondLastName) || "(vacío)"}\n\n` +
                    "¿Están correctos?\n\n" +
                    "1️⃣ Sí\n" +
                    "2️⃣ No, quiero editarlos\n\n" +
                    "0️⃣ Volver al menú",
                nextState: "AGENDAR",
                data,
            };
        }

        case "REG_CONFIRM_NAMES": {
            if (msg === "0") return returnToMenu();

            if (msg === "1") {
                data.step = "REG_BIRTHDATE";
                return {
                    response:
                        "Fecha de nacimiento (YYYY-MM-DD). Ej: 1967-12-05",
                    nextState: "AGENDAR",
                    data,
                };
            }

            if (msg === "2") {
                data.step = "REG_FIRSTNAME";
                return {
                    response: "Primer nombre:",
                    nextState: "AGENDAR",
                    data,
                };
            }

            return {
                response: "Responde 1, 2 o 0.",
                nextState: "AGENDAR",
                data,
            };
        }

        case "REG_FIRSTNAME": {
            if (msg === "0") return returnToMenu();
            const v = String(msg || "").trim();

            if (v.length < 2) {
                return {
                    response: "Primer nombre inválido. Intenta de nuevo:",
                    nextState: "AGENDAR",
                    data,
                };
            }

            data.regPatient.firstName = capitalize(v);
            data.step = "REG_SECONDNAME";
            return {
                response: "Segundo nombre (si no tienes, escribe 0):",
                nextState: "AGENDAR",
                data,
            };
        }

        case "REG_SECONDNAME": {
            if (msg === "0") data.regPatient.secondName = "";
            else data.regPatient.secondName = capitalize(msg);

            data.step = "REG_FIRSTLASTNAME";
            return { response: "Primer apellido:", nextState: "AGENDAR", data };
        }

        case "REG_FIRSTLASTNAME": {
            const v = String(msg || "").trim();
            if (v.length < 2) {
                return {
                    response: "Apellido inválido. Intenta de nuevo:",
                    nextState: "AGENDAR",
                    data,
                };
            }

            data.regPatient.firstLastName = capitalize(v);
            data.step = "REG_SECONDLASTNAME";
            return {
                response: "Segundo apellido (si no tienes, escribe 0):",
                nextState: "AGENDAR",
                data,
            };
        }

        case "REG_SECONDLASTNAME": {
            if (msg === "0") data.regPatient.secondLastName = "";
            else data.regPatient.secondLastName = capitalize(msg);

            data.step = "REG_BIRTHDATE";
            return {
                response: "Fecha de nacimiento (YYYY-MM-DD). Ej: 1967-12-05",
                nextState: "AGENDAR",
                data,
            };
        }

        case "REG_BIRTHDATE": {
            if (msg === "0") return returnToMenu();

            const v = String(msg || "").trim();
            if (!isValidBirthDateYmd(v)) {
                return {
                    response: "Fecha inválida. Usa YYYY-MM-DD. Ej: 1967-12-05",
                    nextState: "AGENDAR",
                    data,
                };
            }

            data.regPatient.birthDate = v;
            data.step = "REG_GENDER";
            return {
                response:
                    "Género:\n\n" +
                    "1️⃣ Masculino\n" +
                    "2️⃣ Femenino\n\n" +
                    "0️⃣ Volver al menú",
                nextState: "AGENDAR",
                data,
            };
        }

        case "REG_GENDER": {
            if (msg === "0") return returnToMenu();

            if (msg !== "1" && msg !== "2") {
                return {
                    response: "Elige 1 o 2, o 0 para volver al menú.",
                    nextState: "AGENDAR",
                    data,
                };
            }

            data.regPatient.gender = Number(msg);
            data.step = "REG_EMAIL";
            return {
                response: "Correo electrónico (si no tienes, escribe 0):",
                nextState: "AGENDAR",
                data,
            };
        }

        case "REG_EMAIL": {
            if (msg === "0") data.regPatient.email = "";
            else {
                const em = normalizeEmail(msg);
                if (em === null) {
                    return {
                        response:
                            "Correo inválido. Intenta de nuevo o escribe 0:",
                        nextState: "AGENDAR",
                        data,
                    };
                }
                data.regPatient.email = em;
            }

            data.step = "REG_EPS";
            return {
                response:
                    "¿Cuál es tu EPS?\n\n" +
                    "Escribe el nombre (ej: Suramericana, Colsanitas).\n" +
                    "Si es particular, escribe PARTICULAR.\n\n" +
                    "0️⃣ Volver al menú",
                nextState: "AGENDAR",
                data,
            };
        }

        case "REG_EPS": {
            const v = normKey(msg);

            if (v === "0") {
                data.regPatient.eps = 0;
                data.regPatient.epsName = "";
                data.regPatient.isParticular = true;
            } else if (v === "particular" || v === "no aplica") {
                data.regPatient.eps = 0;
                data.regPatient.epsName = "PARTICULAR";
                data.regPatient.isParticular = true;
            } else if (EPS_CONVENIO[v]) {
                data.regPatient.eps = EPS_CONVENIO[v].id;
                data.regPatient.epsName = EPS_CONVENIO[v].label;
                data.regPatient.isParticular = false;
            } else {
                data.regPatient.eps = 0;
                data.regPatient.epsName = msg;
                data.regPatient.isParticular = true;
            }

            data.step = "REG_HABEAS";
            return {
                response:
                    "Autorización de tratamiento de datos (Habeas Data):\n\n" +
                    "1️⃣ Sí, autorizo\n" +
                    "2️⃣ No autorizo\n\n" +
                    "0️⃣ Volver al menú",
                nextState: "AGENDAR",
                data,
            };
        }

        case "REG_HABEAS": {
            if (msg === "0") return returnToMenu();

            if (msg !== "1" && msg !== "2") {
                return {
                    response: "Responde 1 o 2, o 0.",
                    nextState: "AGENDAR",
                    data,
                };
            }

            data.regPatient.habeasData = msg === "1";
            data.step = "FILTRO_COLUMNA";

            return {
                response:
                    "Gracias. Continuemos con el agendamiento.\n\n" +
                    "¿Tu consulta está relacionada con dolor lumbar, cervical o problemas de columna?\n\n" +
                    "1️⃣ Sí\n" +
                    "2️⃣ No\n\n" +
                    "0️⃣ Volver al menú",
                nextState: "AGENDAR",
                data,
            };
        }

        case "FILTRO_COLUMNA": {
            if (msg === "0") return returnToMenu();

            if (msg === "1") {
                data.step = "ASK_DATE";
                return {
                    response:
                        "¿Para qué fecha deseas agendar la cita?\n(DD/MM)",
                    nextState: "AGENDAR",
                    data,
                };
            }

            if (msg === "2") {
                data.step = "FILTRO_CONFIRM";
                return {
                    response:
                        "El Dr. se especializa principalmente en problemas de columna.\n\n" +
                        "¿Deseas continuar con el agendamiento?\n\n" +
                        "1️⃣ Sí\n" +
                        "0️⃣ Volver al menú",
                    nextState: "AGENDAR",
                    data,
                };
            }

            return {
                response: "Responde 1 o 2, o 0 para volver al menú.",
                nextState: "AGENDAR",
                data,
            };
        }

        case "FILTRO_CONFIRM": {
            if (msg === "0") return returnToMenu();

            if (msg === "1") {
                data.step = "ASK_DATE";
                return {
                    response:
                        "¿Para qué fecha deseas agendar la cita?\n(DD/MM)",
                    nextState: "AGENDAR",
                    data,
                };
            }

            return {
                response: "Responde 1 para continuar o 0 para volver al menú.",
                nextState: "AGENDAR",
                data,
            };
        }

        case "ASK_DATE": {
            if (!isValidDateDDMM(msg)) {
                return {
                    response:
                        "❌ Fecha no válida o muy pronto.\n\n" +
                        "Ten en cuenta:\n" +
                        "• Las citas se agendan con al menos 2 días de anticipación.\n" +
                        "• No atendemos miércoles, sábados, domingos ni festivos.\n" +
                        "• Formato: DD/MM (ej: 15/05).\n\n" +
                        "Por favor, ingresa otra fecha:",
                    nextState: "AGENDAR",
                    data,
                };
            }

            data.date = msg;
            data.ymd = ddmmToYmd(msg);
            data.page = 0;

            try {
                const booked = await getBookedHmFromDb({
                    ymd: data.ymd,
                    doctorDoc: DOCTOR_DOCUMENT_NUMBER,
                });
                data.bookedHm = Array.isArray(booked) ? booked : [];
            } catch (e) {
                data.bookedHm = [];
                if (SALUDTOOLS_DEBUG) {
                    console.error("DB booked slots error:", e);
                }
            }

            data.step = "ASK_TIME";
            return buildTimeResponse(data);
        }

        case "ASK_TIME": {
            if (msg === "0") return returnToMenu();

            if (isValidDateDDMM(msg)) {
                data.date = msg;
                data.ymd = ddmmToYmd(msg);
                data.page = 0;

                try {
                    const booked = await getBookedHmFromDb({
                        ymd: data.ymd,
                        doctorDoc: DOCTOR_DOCUMENT_NUMBER,
                    });
                    data.bookedHm = Array.isArray(booked) ? booked : [];
                } catch (e) {
                    data.bookedHm = [];
                    if (SALUDTOOLS_DEBUG) {
                        console.error("DB booked slots error:", e);
                    }
                }

                return buildTimeResponse(data);
            }

            if (msg === "7") {
                data.page++;
                return buildTimeResponse(data);
            }

            const slots = Array.isArray(data.visibleSlots)
                ? data.visibleSlots
                : getSlotsForDate(data.ymd, data.page || 0);

            const index = Number(msg) - 1;

            if (!Number.isFinite(index) || index < 0 || index >= slots.length) {
                return {
                    response:
                        `Elige una opción válida (1 a ${slots.length}).\n\n` +
                        "También puedes escribir otra fecha en formato DD/MM.\n\n" +
                        "7️⃣ Ver más horarios\n" +
                        "0️⃣ Volver al menú",
                    nextState: "AGENDAR",
                    data,
                };
            }

            const hour = slots[index];

            let bookedNow = false;
            try {
                bookedNow = await isSlotBookedInDb({
                    ymd: data.ymd,
                    hm: hour,
                    doctorDoc: DOCTOR_DOCUMENT_NUMBER,
                });
            } catch (e) {
                bookedNow = false;
                if (SALUDTOOLS_DEBUG) {
                    console.error("DB slot check error:", e);
                }
            }

            if (bookedNow) {
                data.bookedHm = Array.isArray(data.bookedHm)
                    ? data.bookedHm
                    : [];
                if (!data.bookedHm.includes(hour)) data.bookedHm.push(hour);

                const ui = buildTimeResponse(data);
                return {
                    ...ui,
                    response:
                        "El horario seleccionado ya no se encuentra disponible.\n" +
                        "Por favor elige otro horario:\n\n" +
                        ui.response,
                };
            }

            data.time = hour;
            data.step = "ASK_TYPE";

            return {
                response:
                    `Perfecto ✅\n\n` +
                    `Fecha: ${data.date}\n` +
                    `Hora: ${hour}\n\n` +
                    "Ahora selecciona\n\n" +
                    "¿Qué tipo de atención deseas?\n\n" +
                    "1️⃣ Consulta particular\n" +
                    "2️⃣ Consulta con póliza / prepagada\n\n" +
                    "0️⃣ Volver al menú",
                nextState: "AGENDAR",
                data,
            };
        }

        case "ASK_TYPE": {
            if (msg === "0") return returnToMenu();

            if (msg === "1") data.attentionType = "Consulta particular";
            else if (msg === "2") {
                data.attentionType = "Consulta con póliza/prepagada";
            } else {
                return {
                    response:
                        "Selecciona una opción válida:\n\n" +
                        "1️⃣ Consulta particular\n" +
                        "2️⃣ Consulta con póliza / prepagada\n\n" +
                        "0️⃣ Volver al menú",
                    nextState: "AGENDAR",
                    data,
                };
            }

            data.step = "SHOW_COST_INFO";
            return {
                response:
                    "La consulta particular tiene un valor de $400.000\n\n" +
                    "Si son controles continuos el valor puede ser menor (previa validación).\n\n" +
                    "Los descuentos son autorizados directamente por el Dr.\n\n" +
                    "1️⃣ Continuar\n" +
                    "0️⃣ Volver al menú",
                nextState: "AGENDAR",
                data,
            };
        }

        case "SHOW_COST_INFO": {
            if (msg === "0") return returnToMenu();

            if (msg !== "1") {
                return {
                    response:
                        "Responde 1 para continuar o 0 para volver al menú.",
                    nextState: "AGENDAR",
                    data,
                };
            }

            const appointmentId = await createProposedAppointment({
                phone,
                fullName: data.fullName,
                date: data.date,
                time: data.time,
                attentionType: data.attentionType,
                status: "QUEUED",
            });
            data.appointmentId = appointmentId;

            await logAppointmentMessage(
                appointmentId,
                "Inicio de agendamiento por bot",
            );
            await logAppointmentMessage(
                appointmentId,
                `Paciente: ${data.fullName}`,
            );
            await logAppointmentMessage(appointmentId, `Teléfono: ${phone}`);
            await logAppointmentMessage(
                appointmentId,
                `Documento tipo: ${data.patientDocumentType}`,
            );
            await logAppointmentMessage(
                appointmentId,
                `Documento número: ${data.patientDocumentNumber}`,
            );
            await logAppointmentMessage(
                appointmentId,
                `Fecha: ${data.date} | Hora: ${data.time}`,
            );
            await logAppointmentMessage(
                appointmentId,
                `Tipo de atención: ${data.attentionType}`,
            );
            await logAppointmentMessage(
                appointmentId,
                "Solicitud encolada para procesamiento completo en worker",
            );

            const ymd = ddmmToYmd(data.date);
            const end = addMinutesToYmdHm(
                ymd,
                data.time,
                APPOINTMENT_DURATION_MIN,
            );

            let patientBody = null;

            if (!data.patientExistsLocal) {
                const patientBodyRaw = {
                    firstName: data.regPatient?.firstName || "",
                    secondName: data.regPatient?.secondName || "",
                    firstLastName: data.regPatient?.firstLastName || "",
                    secondLastName: data.regPatient?.secondLastName || "",
                    birthDate: data.regPatient?.birthDate || "",
                    gender: Number(data.regPatient?.gender || 0),
                    documentType: Number(data.patientDocumentType),
                    documentNumber: String(data.patientDocumentNumber),
                    phone: parsePhoneE164ToDigits(phone),
                    cellPhone: parsePhoneE164ToDigits(phone),
                    email: data.regPatient?.email || "",
                    eps: data.regPatient?.eps ? Number(data.regPatient.eps) : 0,
                    habeasData: Boolean(data.regPatient?.habeasData),
                };

                const checked = validateAndNormalizePatientBody(patientBodyRaw);
                if (!checked.ok) {
                    data.step = checked.step;
                    return {
                        response: checked.message,
                        nextState: "AGENDAR",
                        data,
                    };
                }

                patientBody = checked.body;
            }

            await updateAppointmentStatusById(appointmentId, "QUEUED");

            await createSaludtoolsJob({
                jobType: "APPOINTMENT_CREATE",
                phone,
                appointmentId,
                dedupeKey: `appointment:${data.patientDocumentType}:${data.patientDocumentNumber}:${ymd}:${data.time}`,
                payload: {
                    fullName: data.fullName,
                    dateLabel: data.date,
                    timeLabel: data.time,
                    patientExistsLocal: Boolean(data.patientExistsLocal),
                    patientBody,
                    appointmentBody: {
                        startAppointment: `${ymd} ${data.time}`,
                        endAppointment: `${end.ymd} ${end.hm}`,
                        patientDocumentType: Number(data.patientDocumentType),
                        patientDocumentNumber: String(
                            data.patientDocumentNumber,
                        ),
                        doctorDocumentType: DOCTOR_DOCUMENT_TYPE,
                        doctorDocumentNumber: DOCTOR_DOCUMENT_NUMBER,
                        modality: APPOINTMENT_MODALITY,
                        stateAppointment: APPOINTMENT_STATE,
                        appointmentType: APPOINTMENT_TYPE_DEFAULT,
                        clinic: CLINIC_ID,
                        comment: `Creada por chatbot. Paciente: ${data.fullName}. Tel: ${phone}`,
                    },
                },
                priority: 110,
            });

            data.step = "POST_CREATED";
            return {
                response:
                    `Perfecto ${data.firstName}.\n\n` +
                    `Tipo: *${data.attentionType}*\n\n` +
                    "Tu solicitud quedó en proceso.\n\n" +
                    "Te escribiremos por este medio cuando la validación del paciente y la cita queden procesadas.\n\n" +
                    "Responde:\n" +
                    "1️⃣ Entendido\n" +
                    "2️⃣ Volver al menú",
                nextState: "AGENDAR",
                data,
            };
        }

        case "POST_CREATED": {
            if (msg === "1") {
                return {
                    response:
                        `Listo ${data.firstName}.\n\n` +
                        "Seguiremos procesando tu solicitud y te avisaremos por este medio cuando quede confirmada.",
                    nextState: "MENU",
                    data: { renderMenu: true },
                };
            }

            if (msg === "2") return returnToMenu();
            return { response: "Responde 1 o 2.", nextState: "AGENDAR", data };
        }

        default:
            return {
                response:
                    "Vamos a iniciar el agendamiento.\n\n¿Cuál es tu nombre completo?",
                nextState: "AGENDAR",
                data: { step: "ASK_NAME" },
            };
    }
}
