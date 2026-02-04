import "dotenv/config";
import express from "express";
import bodyParser from "body-parser";
import chatbotResponse from "./chatbot.js";

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
 * Webhook Twilio WhatsApp
 */
app.post("/webhook", async (req, res) => {
    try {
        const message = req.body.Body || "";
        const from = req.body.From || "";
        const phone = from.replace("whatsapp:", "");

        if (!sessions[phone]) {
            sessions[phone] = {
                state: "MENU",
                data: {},
            };
        }

        const session = sessions[phone];
        const context = { from: phone };

        const result = await chatbotResponse(message, session, context);

        session.state = result.nextState;
        session.data = result.data || {};

        res.set("Content-Type", "text/xml");

        // 🛑 NO MENSAJE → RESPUESTA VACÍA (NO "OK", NO "null")
        if (!result.response) {
            return res.send("<Response></Response>");
        }

        // ✅ MENSAJE NORMAL
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
