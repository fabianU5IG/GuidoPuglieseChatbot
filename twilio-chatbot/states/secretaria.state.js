function secretariaState(rawMsg, data) {
  data.mensajeSecretaria = rawMsg;
  return { response: "Gracias. Mensaje enviado a secretaría.", nextState: "MENU", data };
}
module.exports = secretariaState;
