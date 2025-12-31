const express = require("express");
const bodyParser = require("body-parser");
const chatbotResponse = require("./chatbot");

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));

const sessions = {};

app.get("/", (req, res) => {
    res.send("🤖 Chatbot Dr. Guido - OK");
});

app.post("/webhook", (req, res) => {
    const from = req.body.From;
    const message = (req.body.Body || "").trim();

    if (!sessions[from]) {
        sessions[from] = {
            state: "START",
            data: {},
        };
    }

    const session = sessions[from];
    const { response, nextState, data } = chatbotResponse(message, session);

    session.state = nextState;
    session.data = data;

    res.set("Content-Type", "text/xml");
    res.send(`
    <Response>
      <Message>${response}</Message>
    </Response>
  `);
});

app.listen(3000, () => {
    console.log("🤖 Server running on port 3000");
});
