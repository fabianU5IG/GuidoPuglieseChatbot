require("dotenv").config();

const express = require("express");
const bodyParser = require("body-parser");
const twilio = require("twilio");
const { MessagingResponse } = twilio.twiml;

const chatbotResponse = require("./chatbot");
const {
    isMainMenuText,
    isInfoMenuText,
    parseConfirmMenu,
    normalizeLabel,
    MAIN_MENU_MAP,
    INFO_MENU_MAP,
} = require("./menuUtils");

const { sendContentTemplate } = require("./twilioInteractive");

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));

/**
 * Memoria simple en RAM (OK para MVP).
 * En producción con múltiples instancias → Redis / DB.
 */
const sessions = {};

app.get("/", (req, res) => {
    res.send("🤖 Chatbot Doctoralia - OK");
});

app.post("/webhook", async (req, res) => {
    try {
        const from = (req.body.From || "").trim();
        const inboundBody = (req.body.Body || "").trim();

        const buttonPayload = (req.body.ButtonPayload || "").trim();
        const buttonText = (req.body.ButtonText || "").trim();

        if (!from) {
            return res.status(400).send("Missing From");
        }

        if (!sessions[from]) {
            sessions[from] = {
                state: "MENU",
                data: {},
                lastMenuMap: {},
            };
        }

        const session = sessions[from];

        // 1️⃣ Normalizar input
        let userMessage = buttonPayload || inboundBody;

        // 2️⃣ Resolver clicks sin payload (fallback por texto)
        if (!buttonPayload && inboundBody) {
            const key = normalizeLabel(inboundBody);
            if (session.lastMenuMap[key]) {
                userMessage = session.lastMenuMap[key];
            }
        }

        // 3️⃣ Ejecutar lógica del bot
        const result = chatbotResponse(userMessage, session);

        if (!result || !result.response) {
            throw new Error("chatbotResponse returned invalid result");
        }

        session.state = result.nextState;
        session.data = result.data;

        const respondEmpty = () => {
            const twiml = new MessagingResponse();
            res.type("text/xml").send(twiml.toString());
        };

        // =============================
        // MENÚ PRINCIPAL (LIST)
        // =============================
        if (
            isMainMenuText(result.response) &&
            process.env.CONTENT_SID_MENU_PRINCIPAL
        ) {
            await sendContentTemplate({
                to: from,
                contentSid: process.env.CONTENT_SID_MENU_PRINCIPAL,
            });

            session.lastMenuMap = MAIN_MENU_MAP;
            return respondEmpty();
        }

        // =============================
        // MENÚ INFO (LIST)
        // =============================
        if (
            isInfoMenuText(result.response) &&
            process.env.CONTENT_SID_MENU_INFO
        ) {
            await sendContentTemplate({
                to: from,
                contentSid: process.env.CONTENT_SID_MENU_INFO,
            });

            session.lastMenuMap = INFO_MENU_MAP;
            return respondEmpty();
        }

        // =============================
        // CONFIRMACIONES (QUICK REPLIES)
        // =============================
        const confirm = parseConfirmMenu(result.response);

        if (confirm) {
            const optCount = confirm.options.length;

            if (optCount === 2 && process.env.CONTENT_SID_CONFIRM_2) {
                await sendContentTemplate({
                    to: from,
                    contentSid: process.env.CONTENT_SID_CONFIRM_2,
                    contentVariables: {
                        1: confirm.body,
                        2: confirm.options[0].label,
                        3: confirm.options[1].label,
                    },
                });

                session.lastMenuMap = confirm.options.reduce((acc, opt) => {
                    acc[normalizeLabel(opt.label)] = String(opt.id);
                    return acc;
                }, {});

                return respondEmpty();
            }

            if (optCount === 3 && process.env.CONTENT_SID_CONFIRM_3) {
                await sendContentTemplate({
                    to: from,
                    contentSid: process.env.CONTENT_SID_CONFIRM_3,
                    contentVariables: {
                        1: confirm.body,
                        2: confirm.options[0].label,
                        3: confirm.options[1].label,
                        4: confirm.options[2].label,
                    },
                });

                session.lastMenuMap = confirm.options.reduce((acc, opt) => {
                    acc[normalizeLabel(opt.label)] = String(opt.id);
                    return acc;
                }, {});

                return respondEmpty();
            }
        }

        // =============================
        // FALLBACK TEXTO
        // =============================
        const twiml = new MessagingResponse();
        twiml.message(result.response);
        res.type("text/xml").send(twiml.toString());
    } catch (error) {
        console.error("❌ Error en webhook:", error);

        const twiml = new MessagingResponse();
        twiml.message(
            "Lo siento, ocurrió un error procesando tu mensaje. Por favor intenta nuevamente.",
        );
        res.type("text/xml").send(twiml.toString());
    }
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
    console.log(`🤖 Server running on port ${port}`);
});
