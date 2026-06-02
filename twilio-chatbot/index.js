import "dotenv/config";
import express from "express";
import bodyParser from "body-parser";
import chatbotResponse from "./chatbot.js";
import saludtoolsWebhook from "./webhooks/saludtools.webhook.js";
import { sendWhatsAppTemplate } from "./services/whatsapp.service.js";

const app = express();
const PORT = process.env.PORT || 3000;

const sessions = {};

app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

app.use("/webhook/saludtools", saludtoolsWebhook);

app.post("/webhook", async (req, res) => {
    try {
        const message = req.body.Body || "";
        const from = req.body.From || "";
        const phone = from.replace("whatsapp:", "");
        const numMedia = Number(req.body.NumMedia || 0);

        console.log("📩 Mensaje entrante:", {
            from,
            body: message,
            numMedia,
        });

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

        console.log("🤖 Resultado chatbot:", result);

        session.state = result.nextState;
        session.data = result.data || {};

        res.set("Content-Type", "text/xml");

        if (result.sendTemplate && result.template?.contentSid) {
            console.log("📤 Enviando template:", result.template.contentSid);

            const twilioResponse = await sendWhatsAppTemplate(
                from,
                result.template.contentSid,
                result.template.variables || null,
            );

            console.log("✅ Template enviado:", {
                sid: twilioResponse.sid,
                status: twilioResponse.status,
                errorCode: twilioResponse.errorCode,
                errorMessage: twilioResponse.errorMessage,
            });

            return res.send("<Response></Response>");
        }

        if (!result.response) {
            return res.send("<Response></Response>");
        }

        return res.send(`
<Response>
  <Message>${result.response}</Message>
</Response>
        `);
    } catch (error) {
        console.error("❌ Error en webhook:", error);
        res.set("Content-Type", "text/xml");
        return res.send("<Response></Response>");
    }
});

app.listen(PORT, () => {
    console.log(`✅ Chatbot corriendo en puerto ${PORT}`);
});
