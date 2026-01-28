function menuState(msg, data) {
  if (msg === "1") {
    return { response: "Perfecto. ¿Cuál es tu nombre completo?", nextState: "AGENDAR_NOMBRE", data };
  }
  if (msg === "5") {
    return { response: "Escribe tu mensaje para secretaría y tu nombre completo.", nextState: "SECRETARIA", data };
  }
  return {
    response:
      "Soy el asistente del consultorio del Dr. Guido Pugliese.\n\n" +
      "1️⃣ Agendar cita\n" +
      "5️⃣ Hablar con secretaría",
    nextState: "MENU",
    data,
  };
}
module.exports = menuState;
