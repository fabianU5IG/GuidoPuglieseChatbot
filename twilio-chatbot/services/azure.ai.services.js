import OpenAI from "openai";

// El cliente se crea solo la primera vez que realmente se necesita (no al
// importar el módulo). Así, si falta o es inválida la configuración de Azure
// OpenAI, solo fallan las funciones que dependen de IA (con su propio
// try/catch) en vez de tumbar todo el proceso del bot al iniciar.
let client = null;

function getClient() {
    if (!client) {
        client = new OpenAI({
            baseURL: process.env.AZURE_OPENAI_ENDPOINT,
            apiKey: process.env.AZURE_OPENAI_API_KEY,
        });
    }
    return client;
}

function isAIEnabled() {
    return Boolean(
        process.env.AZURE_OPENAI_ENDPOINT &&
            process.env.AZURE_OPENAI_API_KEY &&
            process.env.AZURE_OPENAI_DEPLOYMENT,
    );
}

async function chatCompletion({ messages, temperature = 0.2, maxTokens = 500 }) {
    if (!isAIEnabled()) {
        throw new Error("Azure OpenAI no está configurado");
    }

    const completion = await getClient().chat.completions.create({
        model: process.env.AZURE_OPENAI_DEPLOYMENT,
        messages,
        temperature,
        max_tokens: maxTokens,
    });

    return completion.choices?.[0]?.message?.content || "";
}

function truncateAtWordBoundary(text = "", maxLen = 180) {
    const value = String(text || "");
    if (value.length <= maxLen) return value;

    const cut = value.slice(0, maxLen);
    const lastSpace = cut.lastIndexOf(" ");
    return (lastSpace > 0 ? cut.slice(0, lastSpace) : cut).trim() + "…";
}

function extractJson(raw = "") {
    const text = String(raw || "").trim();
    if (!text) return null;

    try {
        return JSON.parse(text);
    } catch {}

    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return null;

    try {
        return JSON.parse(match[0]);
    } catch {
        return null;
    }
}

export async function askAI(message, context = "") {
    try {
        const content = await chatCompletion({
            temperature: 0.4,
            maxTokens: 700,
            messages: [
                {
                    role: "system",
                    content: `
Eres el asistente virtual del Dr. Guido Pugliese.

Funciones:
- Resolver dudas generales de pacientes.
- Explicar procedimientos de forma sencilla.
- Orientar sobre citas.
- No dar diagnósticos médicos.
- No reemplazar la valoración del médico.
- Si la consulta requiere agenda, dirige al flujo de citas.
${context}
                    `,
                },
                { role: "user", content: message },
            ],
        });

        return content || "Lo siento, en este momento no puedo procesar tu solicitud.";
    } catch (error) {
        console.error("Azure AI Error:", error?.message || error);
        return "Lo siento, en este momento no puedo procesar tu solicitud.";
    }
}

export async function normalizeAppointmentInputAI({ message, step, data = {} }) {
    try {
        const today = new Date().toISOString().slice(0, 10);
        const raw = await chatCompletion({
            temperature: 0,
            maxTokens: 260,
            messages: [
                {
                    role: "system",
                    content:
                        "Eres un normalizador JSON para un chatbot de agendamiento médico. " +
                        "Devuelve únicamente JSON válido, sin markdown. " +
                        "No inventes datos. Si no hay certeza, usa null. " +
                        "Campos permitidos: intent, value, confidence. " +
                        "intent puede ser: YES, NO, BACK_MENU, DOC_TYPE, DATE_DDMM, HOUR_BUTTON, MORE_HOURS, ATTENTION_TYPE, CONTINUE, RECOMMENDATION, UNKNOWN. " +
                        "Usa RECOMMENDATION cuando el usuario solicite una fecha u hora disponible mediante lenguaje natural, aunque no use palabras exactas. " +
                        "Ejemplos: 'lo más pronto', 'lo más pronto posible', 'la más próxima', 'la próxima que tenga', 'la primera que haya', " +
                        "'cualquier hora', 'alguna en la tarde', 'la próxima semana', 'el jueves en la mañana' o expresiones equivalentes. " +
                        "En RECOMMENDATION, value debe conservar la preferencia original del usuario o ser null." +
                        "value debe ser el valor normalizado: 1/2, DD/MM, hora_1..hora_6, mas_horarios, particular, prepagada, o null.",
                },
                {
                    role: "user",
                    content: JSON.stringify({
                        today,
                        step,
                        message,
                        currentDate: data.date || null,
                        visibleSlots: data.visibleSlots || [],
                    }),
                },
            ],
        });

        const parsed = extractJson(raw);
        if (!parsed || typeof parsed !== "object") return null;
        return {
            intent: parsed.intent || "UNKNOWN",
            value: parsed.value ?? null,
            confidence: Number(parsed.confidence || 0),
        };
    } catch (error) {
        console.error("Azure AI normalizeAppointmentInputAI Error:", error?.message || error);
        return null;
    }
}

const FLOW_FALLBACK_INTENTS = [
    "GO_MENU",
    "GO_SCHEDULE",
    "GO_MANAGE_APPOINTMENT",
    "GO_INFO_COSTOS",
    "GO_TELECONSULTA",
    "GO_POST_SURGERY",
    "TALK_TO_HUMAN",
    "OPEN_QUESTION",
    "UNKNOWN",
];

export async function classifyFlowIntentAI({
    message,
    currentState,
    currentStep = null,
}) {
    try {
        const raw = await chatCompletion({
            temperature: 0,
            maxTokens: 150,
            messages: [
                {
                    role: "system",
                    content:
                        "Eres un clasificador JSON de intención de navegación para un chatbot médico de WhatsApp. " +
                        "El usuario escribió un mensaje que NO coincidió con ningún botón/palabra clave esperada en la sección actual del bot. " +
                        "Devuelve únicamente JSON válido, sin markdown: {\"intent\":\"...\",\"confidence\":0.0}. " +
                        "intent debe ser exactamente uno de: GO_MENU, GO_SCHEDULE, GO_MANAGE_APPOINTMENT, GO_INFO_COSTOS, GO_TELECONSULTA, GO_POST_SURGERY, TALK_TO_HUMAN, OPEN_QUESTION, UNKNOWN. " +
                        "GO_MENU: quiere volver al inicio/menú principal. " +
                        "GO_SCHEDULE: quiere agendar una cita nueva (ej: 'necesito cita para mañana'). " +
                        "GO_MANAGE_APPOINTMENT: quiere cancelar, reagendar o revisar una cita que YA tiene. " +
                        "GO_INFO_COSTOS: pregunta por precios, costos o información general del consultorio. " +
                        "GO_TELECONSULTA: quiere teleconsulta o lectura de estudios (ej: 'quiero volver a teleconsulta'). " +
                        "GO_POST_SURGERY: es paciente postoperatorio/postquirúrgico. " +
                        "TALK_TO_HUMAN: quiere hablar con una persona/secretaria/asesor sin pedir algo específico (ej: 'quiero hablar con alguien'). " +
                        "OPEN_QUESTION: pregunta genuina de salud/procedimiento/consultorio que no encaja arriba. " +
                        "UNKNOWN: no hay certeza suficiente (usa confidence baja). No inventes intenciones fuera de la lista.",
                },
                {
                    role: "user",
                    content: JSON.stringify({ message, currentState, currentStep }),
                },
            ],
        });

        const parsed = extractJson(raw);
        if (!parsed || typeof parsed !== "object") return null;

        const intent = FLOW_FALLBACK_INTENTS.includes(parsed.intent)
            ? parsed.intent
            : "UNKNOWN";

        return { intent, confidence: Number(parsed.confidence || 0) };
    } catch (error) {
        console.error("Azure AI classifyFlowIntentAI Error:", error?.message || error);
        return null;
    }
}

export async function parseDashboardAppointmentsAI(message) {
    try {
        const today = new Date().toISOString().slice(0, 10);
        const raw = await chatCompletion({
            temperature: 0,
            maxTokens: 900,
            messages: [
                {
                    role: "system",
                    content:
                        "Eres un extractor JSON para citas médicas enviadas por una secretaria. " +
                        "Devuelve únicamente JSON válido, sin markdown. " +
                        "Extrae una o varias citas del texto. No inventes datos. " +
                        "Formato de salida: {\"appointments\":[{\"modality\":\"PRESENCIAL|LLAMADA\",\"dateLabel\":\"DD/MM\",\"timeLabel\":\"HH:MM\",\"rawDocType\":\"cc|ce|ti\",\"patientDocumentType\":1|2|3,\"patientDocumentNumber\":\"...\"}],\"errors\":[\"...\"]}. " +
                        "Mapeo documentos: cc=1, ce=2, ti=3. Si falta un dato requerido, no incluyas esa cita y agrega error breve.",
                },
                {
                    role: "user",
                    content: JSON.stringify({ today, message }),
                },
            ],
        });

        const parsed = extractJson(raw);
        if (!parsed || typeof parsed !== "object") return null;
        return {
            appointments: Array.isArray(parsed.appointments) ? parsed.appointments : [],
            errors: Array.isArray(parsed.errors) ? parsed.errors : [],
        };
    } catch (error) {
        console.error("Azure AI parseDashboardAppointmentsAI Error:", error?.message || error);
        return null;
    }
}

export async function summarizeSecretaryCasesAI(cases = []) {
    try {
        const raw = await chatCompletion({
            temperature: 0.2,
            maxTokens: 450,
            messages: [
                {
                    role: "system",
                    content:
                        "Eres un asistente operativo para secretaría médica. Resume casos pendientes en español, claro y accionable. " +
                        "No inventes información. Prioriza cancelaciones, reagendamientos y datos incompletos. Máximo 8 líneas.",
                },
                {
                    role: "user",
                    content: JSON.stringify({ cases: cases.slice(0, 20) }),
                },
            ],
        });

        return raw.trim();
    } catch (error) {
        console.error("Azure AI summarizeSecretaryCasesAI Error:", error?.message || error);
        return "";
    }
}

/**
 * Ordena y explica opciones reales de agenda. La IA no crea fechas ni horas:
 * únicamente puede seleccionar elementos recibidos en `candidates`.
 */
export async function recommendAppointmentOptionsAI({
    message = "",
    candidates = [],
    consultationMode = "PRESENCIAL",
}) {
    if (!Array.isArray(candidates) || candidates.length === 0) return null;

    try {
        const raw = await chatCompletion({
            temperature: 0.1,
            maxTokens: 500,
            messages: [
                {
                    role: "system",
                    content:
                        "Eres un asistente de agenda médica. Devuelve únicamente JSON válido, sin markdown. " +
                        "Tu función es ordenar opciones REALES suministradas por el sistema según la preferencia del usuario. " +
                        "No inventes fechas, horas, disponibilidad, diagnósticos ni recomendaciones clínicas. " +
                        "Cada opción elegida debe conservar exactamente candidateId, dateLabel y timeLabel. " +
                        "Formato: {\"intro\":\"texto breve\",\"options\":[{\"candidateId\":\"...\",\"dateLabel\":\"DD/MM\",\"timeLabel\":\"HH:MM\",\"reason\":\"motivo operativo breve\"}],\"note\":\"texto breve\"}. " +
                        "Devuelve máximo 3 opciones.",
                },
                {
                    role: "user",
                    content: JSON.stringify({
                        userPreference: message || "Sin preferencia indicada",
                        consultationMode,
                        candidates,
                    }),
                },
            ],
        });

        const parsed = extractJson(raw);
        if (!parsed || !Array.isArray(parsed.options)) return null;

        const allowed = new Map(
            candidates.map((item) => [String(item.candidateId), item]),
        );
        const used = new Set();
        const options = [];

        for (const option of parsed.options) {
            const candidate = allowed.get(String(option?.candidateId || ""));
            if (!candidate || used.has(String(candidate.candidateId))) continue;

            used.add(String(candidate.candidateId));
            const rawReason = truncateAtWordBoundary(
                option?.reason || "Horario disponible",
                120,
            );
            const reason = /diagn[oó]st|medic|tratamiento|dosis|s[ií]ntoma|urgenc/i.test(
                rawReason,
            )
                ? "Disponibilidad próxima según la preferencia indicada"
                : rawReason;

            options.push({
                ...candidate,
                reason,
            });
            if (options.length >= 3) break;
        }

        if (!options.length) return null;

        return {
            intro: truncateAtWordBoundary(
                parsed.intro || "Estas son las opciones más convenientes:",
                180,
            ),
            options,
            note: truncateAtWordBoundary(
                parsed.note ||
                    "La disponibilidad puede cambiar hasta que confirmes la selección.",
                180,
            ),
        };
    } catch (error) {
        console.error(
            "Azure AI recommendAppointmentOptionsAI Error:",
            error?.message || error,
        );
        return null;
    }
}

/**
 * Genera consejos logísticos de preparación. No entrega indicaciones médicas,
 * diagnósticos, triage ni cambios de tratamiento.
 */
export async function generateAppointmentPreparationTipsAI({
    consultationMode = "PRESENCIAL",
    attentionType = "",
    appointmentDate = "",
    appointmentTime = "",
}) {
    try {
        const raw = await chatCompletion({
            temperature: 0.2,
            maxTokens: 280,
            messages: [
                {
                    role: "system",
                    content:
                        "Eres un asistente administrativo de un consultorio de ortopedia. " +
                        "Genera exactamente 3 recomendaciones logísticas breves para preparar una cita. " +
                        "No des diagnósticos, medicamentos, tratamientos, interpretaciones de síntomas ni instrucciones de urgencia. " +
                        "Puedes recomendar tener documentos, autorizaciones, estudios previos, conexión a internet o llegar con anticipación. " +
                        "Devuelve únicamente JSON válido: {\"tips\":[\"...\",\"...\",\"...\"]}.",
                },
                {
                    role: "user",
                    content: JSON.stringify({
                        consultationMode,
                        attentionType,
                        appointmentDate,
                        appointmentTime,
                    }),
                },
            ],
        });

        const parsed = extractJson(raw);
        const forbiddenClinicalContent =
            /diagn[oó]st|medicamento|medicaci[oó]n|tratamiento|dosis|tomar|suspender|urgenc|s[ií]ntoma/i;
        const tips = Array.isArray(parsed?.tips)
            ? parsed.tips
                  .map((tip) => String(tip || "").trim())
                  .filter(
                      (tip) =>
                          Boolean(tip) && !forbiddenClinicalContent.test(tip),
                  )
                  .slice(0, 3)
            : [];

        return tips.length === 3 ? tips : null;
    } catch (error) {
        console.error(
            "Azure AI generateAppointmentPreparationTipsAI Error:",
            error?.message || error,
        );
        return null;
    }
}
