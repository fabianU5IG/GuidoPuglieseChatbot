import { db } from "../db/mysql.js";
import { createSaludtoolsJob } from "../services/saludtools-jobs.service.js";
import { SALUDTOOLS } from "../constants.js";
import { resolveFlowFallback } from "../services/flowFallback.service.js";
import { getScheduleBlocksForYmd } from "../services/doctor-schedule.service.js";

const APPOINTMENT_DURATION_MIN = Number(
    process.env.SALUDTOOLS_APPOINTMENT_DURATION_MIN ||
        SALUDTOOLS.APPOINTMENT_DURATION_MIN,
);
// Debe ser igual a APPOINTMENT_DURATION_MIN: cada slot ofrecido debe durar exactamente
// lo mismo que la cita que va a ocupar, para que no queden huecos ni cruces.
const SLOT_MIN = APPOINTMENT_DURATION_MIN;
const DOCTOR_DOCUMENT_NUMBER =
    process.env.SALUDTOOLS_DOCTOR_DOCUMENT_NUMBER || "72134079";
const DEFAULT_CLINIC_ID = Number(process.env.SALUDTOOLS_CLINIC_ID || 18569);
const DEFAULT_APPOINTMENT_TYPE =
    process.env.SALUDTOOLS_APPOINTMENT_TYPE || "Pruebas Luis";

const TEMPLATE_MENU_PRINCIPAL = "HX8a87673651f780a2781725fb23872427";
const TEMPLATE_ASK_DOC_TYPE =
    process.env.TWILIO_TEMPLATE_SUPPORT_DOC_TYPE_SID ||
    process.env.TWILIO_TEMPLATE_ASK_DOC_TYPE_SID ||
    "HX3b07c0984e3fc8c6d2f96630752ef101";
const TEMPLATE_AVAILABLE_HOURS =
    process.env.TWILIO_TEMPLATE_SUPPORT_AVAILABLE_HOURS_SID ||
    process.env.TWILIO_TEMPLATE_AVAILABLE_HOURS_SID ||
    "HX288f8c61244fb7ccd84dadc3a2b18085";
const TEMPLATE_CITAS_LISTA_1 = "HX410801da590ca6d399a74197ef34bda0";
const TEMPLATE_CITAS_LISTA_2 = "HXc2e53d2dacfe6c92c4a72b8e4b91e1e0";
const TEMPLATE_CITAS_LISTA_3 = "HX072205031a720753efdab0d041c98f4f";
const TEMPLATE_CONFIRMAR_ACCION = "HX61eb5556717309bd3b6d6b0eb78a76e0";
const TEMPLATE_REG_DOCUMENT_NUMBER = "HX6870e9d8c2a707250a7b7b6dd3657bba";

function sendTemplate(contentSid, nextState = "SOPORTE_CITA", data = {}, variables = null) {
    return {
        response: null,
        nextState,
        data,
        sendTemplate: true,
        template: {
            contentSid,
            variables,
        },
    };
}

function returnToMenu(message = null) {
    if (!message) {
        return sendTemplate(TEMPLATE_MENU_PRINCIPAL, "MENU", {});
    }

    return {
        response: message,
        nextState: "MENU",
        data: {},
    };
}

function normalizeOption(value = "") {
    return String(value || "")
        .trim()
        .toLowerCase()
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .replace(/[\u{1F300}-\u{1FAFF}]/gu, "")
        // Solo se colapsa el separador cuando va ENTRE dos caracteres reales
        // (ej: "c.c" -> "c c", "cita_1" -> "cita 1"). Antes tambi\u00e9n se
        // colapsaba uno inicial/final ("-1", "1.", "_1"), y un simple typo
        // con guion como "-1" terminaba normalizado a "1" -- coincidiendo
        // con una opci\u00f3n num\u00e9rica v\u00e1lida (ej: seleccionaba la primera cita
        // de la lista, o "1" = CC, o "1" = s\u00ed en una confirmaci\u00f3n).
        .replace(/(?<=\S)[._-]+(?=\S)/g, " ")
        .replace(/\s+/g, " ")
        .trim();
}

function compact(value = "") {
    return normalizeOption(value).replace(/\s+/g, "_");
}

// Muchos escriben su cédula con puntos de miles ("12.345.678") o espacios
// ("1 2 3 4 5 6 7 8"); antes eso se rechazaba de una porque el regex exigía
// dígitos pegados. Se limpian esos separadores antes de validar.
function normalizeDocumentDigits(raw) {
    return String(raw || "").replace(/[.\s-]+/g, "");
}

function isBackToMenu(input) {
    const t = normalizeOption(input);
    const c = compact(input);
    return (
        t === "0" ||
        t === "menu" ||
        t === "volver" ||
        c === "volver_menu" ||
        c === "menu_principal"
    );
}

function normalizeDocType(input) {
    const t = normalizeOption(input);
    const c = compact(input);

    // CC -> Saludtools 1
    if (
        t === "1" ||
        t === "cc" ||
        t === "c c" ||
        c === "doc_cc" ||
        c === "tipo_cc" ||
        c === "documento_cc" ||
        t.includes("cedula ciudadania") ||
        t.includes("cedula de ciudadania")
    ) {
        return 1;
    }

    // CE -> Saludtools 2
    if (
        t === "2" ||
        t === "ce" ||
        t === "c e" ||
        c === "doc_ce" ||
        c === "tipo_ce" ||
        c === "documento_ce" ||
        t.includes("cedula extranjeria") ||
        t.includes("cedula de extranjeria")
    ) {
        return 2;
    }

    // Pasaporte -> Saludtools 4
    if (
        t === "3" ||
        t === "pasaporte" ||
        c === "doc_pasaporte" ||
        c === "tipo_pasaporte" ||
        c === "documento_pasaporte"
    ) {
        return 4;
    }

    // Registro Civil -> Saludtools 5
    if (
        t === "4" ||
        t === "rc" ||
        t === "r c" ||
        c === "doc_rc" ||
        c === "tipo_rc" ||
        c === "documento_rc" ||
        t.includes("registro civil")
    ) {
        return 5;
    }

    // Tarjeta de Identidad -> Saludtools 6
    if (
        t === "5" ||
        t === "ti" ||
        t === "t i" ||
        c === "doc_ti" ||
        c === "tipo_ti" ||
        c === "documento_ti" ||
        t.includes("tarjeta identidad") ||
        t.includes("tarjeta de identidad")
    ) {
        return 6;
    }

    return null;
}

function normalizeYesNo(input) {
    const t = normalizeOption(input);
    const c = compact(input);

    if (
        [
            "si",
            "s",
            "1",
            "ok",
            "vale",
            "confirmar",
            "aceptar",
            "continuar",
            "confirmo",
        ].includes(t) ||
        [
            "si_cancelar",
            "confirmar_cancelacion",
            "cancelar_confirmar",
            "confirmar_reagendar",
            "si_reagendar",
            "reagendar_confirmar",
        ].includes(c)
    ) {
        return "YES";
    }

    if (
        ["no", "n", "2", "abortar", "volver", "cancelar"].includes(t) ||
        [
            "no_cancelar",
            "no_reagendar",
            "abortar_cancelacion",
            "abortar_reagendar",
            "mantener_cita",
        ].includes(c)
    ) {
        return "NO";
    }

    return "";
}

function isValidHm(value) {
    return /^([01]\d|2[0-3]):[0-5]\d$/.test(String(value || "").trim());
}

function pad2(n) {
    return String(n).padStart(2, "0");
}

function formatYmdToDdMm(ymd) {
    const [y, m, d] = String(ymd || "").split("-");
    if (!y || !m || !d) return "";
    return `${d}/${m}`;
}

function parseDateInput(value) {
    const raw = String(value || "").trim();
    let ymd = "";
    let label = "";

    const ddmm = raw.match(/^(\d{2})[\/-](\d{2})$/);
    if (ddmm) {
        const [, day, month] = ddmm;
        const year = new Date().getFullYear();
        const date = new Date(year, Number(month) - 1, Number(day));
        if (!isNaN(date.getTime())) {
            ymd = `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
            label = `${day}/${month}`;
        }
    }

    const ymdMatch = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (ymdMatch) {
        const [, year, month, day] = ymdMatch;
        const date = new Date(Number(year), Number(month) - 1, Number(day));
        if (!isNaN(date.getTime())) {
            ymd = `${year}-${month}-${day}`;
            label = `${day}/${month}`;
        }
    }

    if (!ymd) return null;

    const minDate = new Date();
    minDate.setHours(0, 0, 0, 0);
    minDate.setDate(minDate.getDate() + 2);

    const selectedDate = new Date(`${ymd}T00:00:00`);
    if (selectedDate < minDate) return null;

    return { ymd, label };
}

function addMinutesToYmdHm(ymd, hm, minutes) {
    const [y, m, d] = ymd.split("-").map(Number);
    const [hh, mm] = hm.split(":").map(Number);
    const dt = new Date(y, m - 1, d, hh, mm, 0, 0);
    dt.setMinutes(dt.getMinutes() + Number(minutes || 0));

    const y2 = dt.getFullYear();
    const m2 = String(dt.getMonth() + 1).padStart(2, "0");
    const d2 = String(dt.getDate()).padStart(2, "0");
    const hh2 = String(dt.getHours()).padStart(2, "0");
    const mm2 = String(dt.getMinutes()).padStart(2, "0");

    return { ymd: `${y2}-${m2}-${d2}`, hm: `${hh2}:${mm2}` };
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

function buildSlotsForBlocks(blocks, slotMin = SLOT_MIN) {
    return blocks.flatMap((block) => buildSlots(block.start, block.end, slotMin));
}

async function getSlotsForDate(ymd, page = 0) {
    const blocks = await getScheduleBlocksForYmd(ymd);
    if (!blocks.length) return [];

    const all = buildSlotsForBlocks(blocks, SLOT_MIN);
    const pageSize = 6;
    return all.slice(Number(page || 0) * pageSize, Number(page || 0) * pageSize + pageSize);
}

function parseHourButton(input) {
    const raw = String(input || "").trim().toLowerCase();
    const t = normalizeOption(input);
    const c = compact(input);

    if (raw === "mas_horarios" || c === "mas_horarios" || t === "mas horarios" || t === "ver mas horarios" || t === "mas" || t === "7") {
        return "MORE";
    }

    const match = c.match(/^hora_([1-6])$/);
    if (match) return Number(match[1]) - 1;

    if (/^[1-6]$/.test(t)) return Number(t) - 1;

    return null;
}

function isCancelledStatus(status) {
    const s = String(status || "").trim().toUpperCase();
    return ["CANCELLED", "CANCELED", "CANCELADO", "NO_SHOW", "NO ATTEND"].includes(s);
}

function formatDbDate(value) {
    if (!value) return "";
    if (value instanceof Date) {
        return `${value.getFullYear()}-${pad2(value.getMonth() + 1)}-${pad2(value.getDate())}`;
    }
    return String(value).slice(0, 10);
}

function formatAppointmentLine(item, idx) {
    const ymd = formatDbDate(item?.start_date);
    const startTime = String(item?.start_time || "").slice(0, 5);
    const endTime = String(item?.end_time || "").slice(0, 5);

    if (!ymd) return `${idx + 1}️⃣ Cita sin fecha`;

    const d = new Date(`${ymd}T00:00:00`);
    if (isNaN(d.getTime())) {
        return `${idx + 1}️⃣ Fecha inválida | ${startTime}${endTime ? " - " + endTime : ""}`;
    }

    const weekday = d.toLocaleDateString("es-CO", { weekday: "long" });
    const datePart = d.toLocaleDateString("es-CO", { day: "2-digit", month: "short" }).replace(".", "");
    const weekdayFormatted = weekday.charAt(0).toUpperCase() + weekday.slice(1);

    return `${idx + 1}️⃣ ${weekdayFormatted} ${datePart} | ${startTime}${endTime ? " - " + endTime : ""}`;
}

function parseAppointmentSelection(input) {
    const t = normalizeOption(input);
    const c = compact(input);

    if (/^\d+$/.test(t)) return Number(t) - 1;

    const match = c.match(/^(cita|appointment|opcion)_?(\d{1,2})$/);
    if (match) return Number(match[2]) - 1;

    return NaN;
}

async function findLocalPatientByDocument(documentNumber) {
    const [rows] = await db.query(
        `
        SELECT saludtools_id, document_type, document_number, full_name
        FROM saludtools_patients
        WHERE document_number = ?
        LIMIT 1
        `,
        [String(documentNumber)],
    );

    return rows?.[0] || null;
}

async function findLocalAppointmentsByDocument(documentNumber) {
    const [rows] = await db.query(
        `
        SELECT
            id,
            saludtools_id,
            patient_document_type,
            patient_document_number,
            doctor_document_number,
            start_date,
            start_time,
            end_date,
            end_time,
            status,
            clinic,
            raw_payload
        FROM saludtools_appointments
        WHERE patient_document_number = ?
          AND start_date >= CURDATE()
          AND UPPER(status) NOT IN ('CANCELLED', 'CANCELED', 'CANCELADO', 'NO_SHOW', 'COMPLETED')
        ORDER BY start_date ASC, start_time ASC
        LIMIT 10
        `,
        [String(documentNumber)],
    );

    return Array.isArray(rows) ? rows : [];
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

async function buildTimeTemplateResponse(data) {
    const ymd = data.newDate;
    const page = Number(data.page || 0);
    const label = data.newDateLabel || formatYmdToDdMm(ymd);
    const slotsAll = await getSlotsForDate(ymd, page);

   if (!slotsAll.length) {
        if (page > 0) data.page = 0;
        return {
            response:
                `😊 Para el ${label} no tenemos horarios de atención disponibles.\n\n` +
                "Puedes intentar con otra fecha en formato DD/MM.\n\n" +
                "0️⃣ Volver al menú",
            nextState: "SOPORTE_CITA",
            data,
        };
    }

    const booked = new Set(Array.isArray(data.bookedHm) ? data.bookedHm : []);
    const slots = slotsAll.filter((h) => !booked.has(h));
    data.visibleSlots = slots;

    if (!slots.length) {
        return {
            response:
                `😊 Por el momento no encuentro más horarios disponibles para el ${label}.\n\n` +
                "Puedes consultar otros horarios o escribir una fecha diferente en formato DD/MM.",
            nextState: "SOPORTE_CITA",
            data,
        };
    }

    return sendTemplate(TEMPLATE_AVAILABLE_HOURS, "SOPORTE_CITA", data, {
        "1": label,
        "2": slots[0] || "🚫 No disponible",
        "3": slots[1] || "🚫 No disponible",
        "4": slots[2] || "🚫 No disponible",
        "5": slots[3] || "🚫 No disponible",
        "6": slots[4] || "🚫 No disponible",
        "7": slots[5] || "🚫 No disponible",
    });
}

function askDocType(data) {
    return sendTemplate(TEMPLATE_ASK_DOC_TYPE, "SOPORTE_CITA", {
        ...data,
        step: "ASK_DOC_TYPE",
        firstName: data?.firstName || "Paciente",
    }, { "1": data?.firstName || "Paciente" });
}

async function handleDocumentSearch({ text, data, phone }) {
    const documento = normalizeDocumentDigits(text);

    if (!/^\d{5,20}$/.test(documento)) {
        return {
            response:
                "😊 Parece que el número de documento no tiene el formato esperado.\n\n" +
                "Por favor, escríbelo nuevamente usando solo números y mínimo 5 dígitos.\n\n" +
                "0️⃣ Volver al menú",
            nextState: "SOPORTE_CITA",
            data: { ...data, step: "ASK_DOCUMENT" },
        };
    }

    try {
        const patient = await findLocalPatientByDocument(documento);
        const citas = await findLocalAppointmentsByDocument(documento);

        if (!patient && !citas.length) {
            await createSaludtoolsJob({
                jobType: "SUPPORT_APPOINTMENT_SEARCH",
                phone,
                dedupeKey: `support-search:${documento}:${data.tipo || "SOPORTE"}`,
                payload: {
                    documento,
                    tipo: data.tipo,
                    patientDocumentType: Number(data.patientDocumentType || 1),
                },
                priority: 90,
            });

            return returnToMenu(
                "😊 No encontré información asociada a ese número de documento por el momento.\n\n" +
                "No te preocupes, validaremos la información en nuestro sistema y te avisaremos por este medio."
            );
        }

        if (!citas.length) {
            await createSaludtoolsJob({
                jobType: "SUPPORT_APPOINTMENT_SEARCH",
                phone,
                dedupeKey: `support-search:${documento}:${data.tipo || "SOPORTE"}`,
                payload: {
                    documento,
                    tipo: data.tipo,
                    patientDocumentType: Number(patient?.document_type || data.patientDocumentType || 1),
                },
                priority: 90,
            });

            return returnToMenu(
                "😊 Por el momento no encontré citas asociadas a ese número de documento.\n\n" +
                "Validaremos la información en nuestro sistema y te avisaremos por este medio."
            );
        }

        const lines = citas.map((it, idx) => formatAppointmentLine(it, idx));
        const actionText = data.tipo === "CANCELAR" ? "cancelar" : "reagendar";

        const nextData = {
            ...data,
            step: "SELECT_APPOINTMENT",
            documento,
            patientDocumentType: Number(patient?.document_type || data.patientDocumentType || citas[0]?.patient_document_type || 1),
            citas,
        };

        // Plantilla con botones reales para 1-3 citas (el caso normal); con 4 o
        // más (raro) se mantiene como texto plano porque no hay una plantilla
        // fija para una cantidad ilimitada de opciones.
        if (citas.length === 1) {
            return sendTemplate(TEMPLATE_CITAS_LISTA_1, "SOPORTE_CITA", nextData, {
                "1": lines[0],
                "2": actionText,
            });
        }
        if (citas.length === 2) {
            return sendTemplate(TEMPLATE_CITAS_LISTA_2, "SOPORTE_CITA", nextData, {
                "1": lines[0],
                "2": lines[1],
                "3": actionText,
            });
        }
        if (citas.length === 3) {
            return sendTemplate(TEMPLATE_CITAS_LISTA_3, "SOPORTE_CITA", nextData, {
                "1": lines[0],
                "2": lines[1],
                "3": lines[2],
                "4": actionText,
            });
        }

        return {
            response:
                "😊 ¡Listo! Encontré estas citas asociadas a tu documento:\n\n" +
                lines.join("\n") +
                `\n\nIndícame el número de la cita que deseas ${actionText}.\n\n` +
                "0️⃣ Volver al menú",
            nextState: "SOPORTE_CITA",
            data: nextData,
        };
    } catch (error) {
        console.error("Error en soporteCitaState (ASK_DOCUMENT):", error);
        return returnToMenu(
            "😊 Tuvimos un inconveniente al consultar tu información.\n\n" +
            "Puedes intentarlo nuevamente o escribir *SECRETARÍA* para que una persona de nuestro equipo te ayude."
        );
    }
}

async function prepareNewDate({ text, data }) {
    const parsed = parseDateInput(text);
    if (!parsed) {
        return {
            response:
                 "😊 Esa fecha no está disponible para reagendamiento.\n\n" +
                    "Recuerda que las citas deben solicitarse con mínimo 2 días de anticipación y el Dr. no atiende miércoles, sábados, domingos ni festivos.\n\n" +
                    "Por favor, intenta con otra fecha en formato DD/MM.\n\n" +
                    "0️⃣ Volver al menú",
            nextState: "SOPORTE_CITA",
            data,
        };
    }

    const blocks = await getScheduleBlocksForYmd(parsed.ymd);
    if (!blocks.length) {
        return {
            response:
                `😊 Para el ${parsed.label} no tenemos horarios de atención disponibles.\n\n` +
                "Puedes intentar con otra fecha en formato DD/MM.\n\n" +
                "0️⃣ Volver al menú",
            nextState: "SOPORTE_CITA",
            data,
        };
    }

    const selectedAppointment =
        Array.isArray(data.citas) && Number.isInteger(data.selectedIndex)
            ? data.citas[data.selectedIndex]
            : null;

    let booked = [];
    try {
        booked = await getBookedHmFromDb({
            ymd: parsed.ymd,
            doctorDoc: selectedAppointment?.doctor_document_number || DOCTOR_DOCUMENT_NUMBER,
        });
    } catch (error) {
        booked = [];
        console.error("Error consultando horarios ocupados para soporte:", error);
    }

    const nextData = {
        ...data,
        step: "ASK_NEW_TIME",
        newDate: parsed.ymd,
        newDateLabel: parsed.label,
        page: 0,
        bookedHm: Array.isArray(booked) ? booked : [],
    };

    return buildTimeTemplateResponse(nextData);
}

export default async function soporteCitaState(msg, data = {}, context = {}) {
    const phone = context.from || "UNKNOWN";
    const text = String(msg || "").trim();
    const { tipo, step } = data;

    if (!step) {
        return askDocType({ ...data, tipo: tipo || "REAGENDAR" });
    }

    if (isBackToMenu(text)) {
        return returnToMenu(null);
    }

    if (step === "ASK_DOC_TYPE") {
        const docType = normalizeDocType(text);

        // Si el paciente escribe directamente el número, asumimos CC para evitar bloqueos.
        if (/^\d{5,20}$/.test(normalizeDocumentDigits(text))) {
            return handleDocumentSearch({
                text,
                data: { ...data, patientDocumentType: Number(data.patientDocumentType || 1), step: "ASK_DOCUMENT" },
                phone,
            });
        }

        if (!docType) {
            return askDocType(data);
        }

        return sendTemplate(
            TEMPLATE_REG_DOCUMENT_NUMBER,
            "SOPORTE_CITA",
            {
                ...data,
                patientDocumentType: docType,
                step: "ASK_DOCUMENT",
            }
        );
    }

    if (step === "ASK_DOCUMENT") {
        return handleDocumentSearch({ text, data, phone });
    }

    if (step === "SELECT_APPOINTMENT") {
        const idx = parseAppointmentSelection(text);
        const citas = Array.isArray(data.citas) ? data.citas : [];

        if (!Number.isFinite(idx) || idx < 0 || idx >= citas.length) {
            const aiFallback = await resolveFlowFallback({
                message: text,
                currentState: "SOPORTE_CITA",
                currentStep: step,
                data,
                context,
            });
            if (aiFallback) return aiFallback;

            return {
                response:
                    "😊 No pude identificar la cita que seleccionaste.\n\n" +
                        "Por favor, elige una de las citas disponibles para continuar.\n\n" +
                        "0️⃣ Volver al menú",
                nextState: "SOPORTE_CITA",
                data,
            };
        }

        const cita = citas[idx];
        const appointmentId = cita?.saludtools_id || cita?.id;

        if (!appointmentId) {
            return returnToMenu(
                "😊 Tuvimos un inconveniente al identificar la cita seleccionada.\n\n" +
                "Por favor, escribe *SECRETARÍA* para que una persona de nuestro equipo pueda ayudarte."
            );
        }

        if (tipo === "CANCELAR") {
            return sendTemplate(
                TEMPLATE_CONFIRMAR_ACCION,
                "SOPORTE_CITA",
                { ...data, step: "CONFIRM_CANCEL", appointmentId, selectedIndex: idx },
                {
                    "1": `😊 Estás a punto de cancelar tu cita del ${formatAppointmentLine(cita, idx).replace(/^\d+️⃣\s*/, "")}.`,
                },
            );
        }

        return {
            response:
                `😊 Vamos a reagendar tu cita del ${formatAppointmentLine(cita, idx).replace(/^\d+️⃣\s*/, "")}.\n\n` +
                "¿Para qué nueva fecha te gustaría programarla?\n\n" +
                "Escribe la fecha en formato DD/MM. Por ejemplo: 15/09.\n\n" +
                "0️⃣ Volver al menú",
            nextState: "SOPORTE_CITA",
            data: {
                ...data,
                step: "ASK_NEW_DATE",
                appointmentId,
                selectedIndex: idx,
            },
        };
    }

    if (step === "CONFIRM_CANCEL") {
        const yn = normalizeYesNo(text);
        if (!yn) {
            const aiFallback = await resolveFlowFallback({
                message: text,
                currentState: "SOPORTE_CITA",
                currentStep: step,
                data,
                context,
            });
            if (aiFallback) return aiFallback;

            return {
                response:
                    "😊 Para continuar, confirma qué deseas hacer:\n\n" +
                        "• Escribe *SÍ* para confirmar.\n" +
                        "• Escribe *NO* para mantener tu cita sin cambios.\n\n" +
                        "0️⃣ Volver al menú",
                nextState: "SOPORTE_CITA",
                data,
            };
        }

        if (yn === "NO") {
            return returnToMenu("😊 ¡Listo! Tu cita se mantiene sin cambios.\n\n" +
        "Si necesitas algo más, puedes volver a consultarnos cuando quieras.");
        }

        const cita = data.citas?.[data.selectedIndex];

        await createSaludtoolsJob({
            jobType: "APPOINTMENT_DELETE",
            phone,
            dedupeKey: `appointment-delete:${data.appointmentId}`,
            payload: {
                appointmentId: data.appointmentId,
                documento: data.documento,
                patientDocumentType: Number(data.patientDocumentType || 1),
                startDate: formatDbDate(cita?.start_date),
                startTime: String(cita?.start_time || "").slice(0, 5),
                endDate: formatDbDate(cita?.end_date),
                endTime: String(cita?.end_time || "").slice(0, 5),
            },
            priority: 100,
        });

        return returnToMenu(
            "😊 ¡Listo! Recibimos tu solicitud de cancelación.\n\n" +
            "La estamos procesando y te avisaremos por este medio cuando quede confirmada."
        );
    }

    if (step === "ASK_NEW_DATE") {
        return prepareNewDate({ text, data });
    }

    if (step === "ASK_NEW_TIME") {
        const maybeDate = parseDateInput(text);
        if (maybeDate) {
            return prepareNewDate({ text, data });
        }

        const hourButton = parseHourButton(text);

        if (hourButton === "MORE") {
            const nextData = { ...data, page: Number(data.page || 0) + 1 };
            return buildTimeTemplateResponse(nextData);
        }

        const slots = Array.isArray(data.visibleSlots)
            ? data.visibleSlots
            : await getSlotsForDate(data.newDate, data.page || 0);

        let index = typeof hourButton === "number" ? hourButton : NaN;
        let selectedHour = "";

        if (Number.isFinite(index) && index >= 0 && index < slots.length) {
            selectedHour = slots[index];
        } else if (isValidHm(text)) {
            selectedHour = text;
        }

        if (!selectedHour) {
            const aiFallback = await resolveFlowFallback({
                message: text,
                currentState: "SOPORTE_CITA",
                currentStep: step,
                data,
                context,
            });
            if (aiFallback) return aiFallback;

            // La plantilla de horarios siempre tiene 6 casillas fijas; las que
            // sobran cuando hay menos horas reales se muestran como "🚫 No
            // disponible", pero siguen siendo tocables. Si el paciente tocó
            // justo una de esas (se reconoció el botón pero está fuera de
            // rango), se le explica eso puntualmente en vez del mensaje
            // genérico de "no pude identificar".
            const tappedEmptySlot =
                typeof hourButton === "number" && hourButton >= slots.length;

            return {
                response: tappedEmptySlot
                    ? "Ese horario no está disponible.\n\n" +
                      "Por favor elige una de las horas que sí aparecen en la lista, o escribe otra fecha en formato DD/MM.\n\n" +
                      "0️⃣ Volver al menú"
                    : "😊 No pude identificar el horario que seleccionaste.\n\n" +
                      "Puedes elegir uno de los horarios disponibles o escribir otra fecha en formato DD/MM.\n\n" +
                      "0️⃣ Volver al menú",
                nextState: "SOPORTE_CITA",
                data,
            };
        }

        const selectedAppointment =
            Array.isArray(data.citas) && Number.isInteger(data.selectedIndex)
                ? data.citas[data.selectedIndex]
                : null;

        let bookedNow = false;
        try {
            bookedNow = await isSlotBookedInDb({
                ymd: data.newDate,
                hm: selectedHour,
                doctorDoc: selectedAppointment?.doctor_document_number || DOCTOR_DOCUMENT_NUMBER,
            });
        } catch (error) {
            bookedNow = false;
            console.error("Error verificando horario seleccionado:", error);
        }

        if (bookedNow) {
            const bookedHm = Array.isArray(data.bookedHm) ? data.bookedHm : [];
            if (!bookedHm.includes(selectedHour)) bookedHm.push(selectedHour);
            return buildTimeTemplateResponse({ ...data, bookedHm });
        }

        return sendTemplate(
            TEMPLATE_CONFIRMAR_ACCION,
            "SOPORTE_CITA",
            { ...data, step: "CONFIRM_RESCHEDULE", newTime: selectedHour },
            {
                "1": `😊 Estás a punto de reagendar tu cita para el ${data.newDateLabel || formatYmdToDdMm(data.newDate)} a las ${selectedHour}.`,
            },
        );
    }

    if (step === "CONFIRM_RESCHEDULE") {
        const yn = normalizeYesNo(text);
        if (!yn) {
            const aiFallback = await resolveFlowFallback({
                message: text,
                currentState: "SOPORTE_CITA",
                currentStep: step,
                data,
                context,
            });
            if (aiFallback) return aiFallback;

            return {
                response:
                    "Por favor responde SI para confirmar o NO para abortar.\n\n0️⃣ Volver al menú",
                nextState: "SOPORTE_CITA",
                data,
            };
        }

        if (yn === "NO") {
            return returnToMenu("Listo, no realizamos cambios.");
        }

        const selectedAppointment =
            Array.isArray(data.citas) && Number.isInteger(data.selectedIndex)
                ? data.citas[data.selectedIndex]
                : null;

        const end = addMinutesToYmdHm(data.newDate, data.newTime, APPOINTMENT_DURATION_MIN);
        const doctorDocumentNumber = String(
            selectedAppointment?.doctor_document_number || DOCTOR_DOCUMENT_NUMBER,
        );
        const clinic = Number(selectedAppointment?.clinic || DEFAULT_CLINIC_ID);

        await createSaludtoolsJob({
            jobType: "APPOINTMENT_UPDATE",
            phone,
            dedupeKey: `appointment-update:${data.appointmentId}:${data.newDate}:${data.newTime}`,
            payload: {
                appointmentId: data.appointmentId,
                documento: data.documento,
                patientDocumentType: Number(
                    data.patientDocumentType || selectedAppointment?.patient_document_type || 1,
                ),
                appointmentBody: {
                    id: String(data.appointmentId),
                    startAppointment: `${data.newDate} ${data.newTime}`,
                    endAppointment: `${end.ymd} ${end.hm}`,
                    patientDocumentType: Number(
                        data.patientDocumentType || selectedAppointment?.patient_document_type || 1,
                    ),
                    patientDocumentNumber: String(data.documento),
                    doctorDocumentType: 1,
                    doctorDocumentNumber,
                    modality: "CONVENTIONAL",
                    stateAppointment: "PENDING",
                    notificationState: "ATTEND",
                    appointmentType: DEFAULT_APPOINTMENT_TYPE,
                    clinic,
                    comment: `Reagendada por chatbot. Documento: ${data.documento}`,
                },
            },
            priority: 100,
        });

        return returnToMenu(
            "😊 ¡Listo! Recibimos tu solicitud de reagendamiento.\n\n" +
            "La estamos procesando y te avisaremos por este medio cuando la nueva fecha y hora queden confirmadas."
        );
    }

    const aiFallback = await resolveFlowFallback({
        message: text,
        currentState: "SOPORTE_CITA",
        currentStep: step || null,
        data,
        context,
    });
    if (aiFallback) return aiFallback;

    return returnToMenu(null);
}
