function postDoctoraliaState(msg, data) {
  if (msg === "1") {
    return { response: "Escribe tu mensaje para secretaría y tu nombre completo.", nextState: "SECRETARIA", data };
  }
  return { response: "1️⃣ Agendar cita\n5️⃣ Hablar con secretaría", nextState: "MENU", data };
}
module.exports = postDoctoraliaState;
