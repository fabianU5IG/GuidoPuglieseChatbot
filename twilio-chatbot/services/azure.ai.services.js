import OpenAI from "openai";

const client = new OpenAI({
    baseURL: process.env.AZURE_OPENAI_ENDPOINT,
    apiKey: process.env.AZURE_OPENAI_API_KEY,
});

export async function askAI(message, context = "") {
    try {
        const completion = await client.chat.completions.create({
            model: process.env.AZURE_OPENAI_DEPLOYMENT,
            messages: [
                {
                    role: "system",
                    content: `
Eres el asistente virtual del Dr. Guido Pugliese.

Funciones:
- Resolver dudas de pacientes.
- Explicar procedimientos.
- Orientar sobre citas.
- No dar diagnósticos médicos.
- Si la consulta requiere agenda, dirige al flujo de citas.
${context}
                    `,
                },
                {
                    role: "user",
                    content: message,
                },
            ],
            temperature: 0.4,
        });

        return completion.choices[0].message.content;
    } catch (error) {
        console.error("Azure AI Error:", error);
        return "Lo siento, en este momento no puedo procesar tu solicitud.";
    }
}
