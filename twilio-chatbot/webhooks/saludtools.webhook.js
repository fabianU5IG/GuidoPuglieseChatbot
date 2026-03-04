import express from "express";

const router = express.Router();

function logWebhook(label, req) {
  console.log(`\n========== SALUDTOOLS WEBHOOK: ${label} ==========`);

  console.log("Headers:");
  console.log(req.headers);

  console.log("Body:");
  console.log(JSON.stringify(req.body, null, 2));

  console.log("=================================================\n");
}

/* Crear cita */
router.post("/appointment/create", (req, res) => {
  logWebhook("APPOINTMENT_CREATE", req);
  res.sendStatus(200);
});

/* Actualizar cita */
router.post("/appointment/update", (req, res) => {
  logWebhook("APPOINTMENT_UPDATE", req);
  res.sendStatus(200);
});

/* Crear paciente */
router.post("/patient/create", (req, res) => {
  logWebhook("PATIENT_CREATE", req);
  res.sendStatus(200);
});

/* Actualizar paciente */
router.post("/patient/update", (req, res) => {
  logWebhook("PATIENT_UPDATE", req);
  res.sendStatus(200);
});

export default router;