const { normalizeText } = require("./utils/text");
const menuState = require("./states/menu.state");
const agendarState = require("./states/agendar.state");
const secretariaState = require("./states/secretaria.state");
const postDoctoraliaState = require("./states/postDoctoralia.state");

function chatbotResponse(message, session) {
  const rawMsg = message || "";
  const msg = normalizeText(rawMsg);
  let state = session.state || "MENU";
  let data = session.data || {};

  if (state === "MENU") return menuState(msg, data);
  if (state.startsWith("AGENDAR")) return agendarState(state, msg, rawMsg, data);
  if (state === "POST_DOCTORALIA") return postDoctoraliaState(msg, data);
  if (state === "SECRETARIA") return secretariaState(rawMsg, data);

  return menuState(msg, data);
}

module.exports = chatbotResponse;
