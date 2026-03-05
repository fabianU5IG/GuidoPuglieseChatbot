import express from "express";
import { syncSaludtoolsAppointment, syncSaludtoolsPatient } from "../services/saludtools-sync.service.js";

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
router.post("/appointment/create", async (req, res) => {
  logWebhook("APPOINTMENT_CREATE", req);
  await syncSaludtoolsAppointment("CREATE", req.body);
  return res.sendStatus(200);
});

/* Actualizar cita */
router.post("/appointment/update", async (req, res) => {
  logWebhook("APPOINTMENT_UPDATE", req);
  await syncSaludtoolsAppointment("UPDATE", req.body);
  return res.sendStatus(200);
});

/* Crear paciente */
router.post("/patient/create", async (req, res) => {
  logWebhook("PATIENT_CREATE", req);
  await syncSaludtoolsPatient("CREATE", req.body);
  return res.sendStatus(200);
});

/* Actualizar paciente */
router.post("/patient/update", async (req, res) => {
  logWebhook("PATIENT_UPDATE", req);
  await syncSaludtoolsPatient("UPDATE", req.body);
  return res.sendStatus(200);
});

export default router;