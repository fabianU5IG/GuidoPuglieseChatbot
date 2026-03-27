import "dotenv/config";
import express from "express";
import bodyParser from "body-parser";
import chatbotResponse from "./chatbot.js";
import saludtoolsWebhook from "./webhooks/saludtools.webhook.js";

const app = express();
const PORT = process.env.PORT || 3000;

/**
 * Sesiones en memoria por número de WhatsApp
 * (suficiente para desarrollo y pruebas)
 */
const sessions = {};

app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

/**
 * Webhook Saludtools
 */
app.use("/webhook/saludtools", saludtoolsWebhook);

/**
 * Webhook Twilio WhatsApp
 */
app.post("/webhook", async (req, res) => {
    try {
        const message = req.body.Body || "";
        const from = req.body.From || "";
        const phone = from.replace("whatsapp:", "");
        const numMedia = Number(req.body.NumMedia || 0);

        const media = Array.from({ length: numMedia }, (_, i) => ({
            url: req.body[`MediaUrl${i}`],
            contentType: req.body[`MediaContentType${i}`],
        })).filter((item) => item.url);

        if (!sessions[phone]) {
            sessions[phone] = {
                state: "MENU",
                data: {},
            };
        }

        const session = sessions[phone];
        const context = {
            from: phone,
            numMedia,
            media,
            rawBody: req.body,
        };

        const result = await chatbotResponse(message, session, context);

        session.state = result.nextState;
        session.data = result.data || {};

        res.set("Content-Type", "text/xml");

        if (!result.response) {
            return res.send("<Response></Response>");
        }

        res.send(`
      <Response>
        <Message>${result.response}</Message>
      </Response>
    `);
    } catch (error) {
        console.error("❌ Error en webhook:", error);
        res.set("Content-Type", "text/xml");
        res.send("<Response></Response>");
    }
});

app.listen(PORT, () => {
    console.log(`✅ Chatbot corriendo en puerto ${PORT}`);
});
