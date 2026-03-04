import express from "express";

const router = express.Router();

router.post("/saludtools", (req, res) => {

  console.log("============== WEBHOOK SALUDTOOLS ==============");

  console.log("Headers:");
  console.log(req.headers);

  console.log("Body recibido:");
  console.log(JSON.stringify(req.body, null, 2));

  console.log("================================================");

  res.status(200).json({
    received: true
  });

});

export default router;