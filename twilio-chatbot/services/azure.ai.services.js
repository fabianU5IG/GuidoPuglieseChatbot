import OpenAI from "openai";

const client = new OpenAI({
    baseURL: process.env.AZURE_OPENAI_ENDPOINT,
    apiKey: process.env.AZURE_OPENAI_API_KEY,
});

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

    const completion = await client.chat.completions.create({
        model: process.env.AZURE_OPENAI_DEPLOYMENT,
        messages,
        temperature,
        max_tokens: maxTokens,
    });

    return completion.choices?.[0]?.message?.content || "";
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
                        "intent puede ser: YES, NO, BACK_MENU, DOC_TYPE, DATE_DDMM, HOUR_BUTTON, MORE_HOURS, ATTENTION_TYPE, CONTINUE, UNKNOWN. " +
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
