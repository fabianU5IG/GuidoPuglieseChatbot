const express = require("express");
const bodyParser = require("body-parser");
const chatbotResponse = require("./chatbot");

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));

// Sesiones en memoria (por WhatsApp number)
const sessions = {};

app.get("/", (req, res) => {
    res.send("🤖 Chatbot Dr. Guido Pugliese activo");
});

app.post("/webhook", (req, res) => {
    const from = req.body.From;
    const message = (req.body.Body || "").trim();

    if (!sessions[from]) {
        sessions[from] = {
            state: "START",
            attempts: 0,
            data: {},
        };
    }

    const session = sessions[from];

    const result = chatbotResponse(message, session);

    session.state = result.nextState;
    session.attempts = result.attempts ?? session.attempts;
    session.data = result.data ?? session.data;

    res.set("Content-Type", "text/xml");
    res.send(`
    <Response>
      <Message>${result.response}</Message>
    </Response>
  `);
});

app.listen(3000, () => {
    console.log("🤖 Server running on port 3000");
});
