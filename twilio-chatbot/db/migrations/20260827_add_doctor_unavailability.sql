-- Días/rangos en los que la secretaria marcó al doctor como no disponible
-- (ej: "el jueves no está" dicho en lenguaje natural desde el panel). El
-- bot revisa esta tabla antes de ofrecer horarios, además del horario
-- semanal fijo. Ejecutar una vez en la base existente (local y luego
-- Hostinger).
CREATE TABLE IF NOT EXISTS doctor_unavailability (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  start_date DATE NOT NULL,
  end_date DATE NOT NULL,
  reason VARCHAR(255) NULL,
  created_by VARCHAR(32) NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_doctor_unavailability_range (start_date, end_date)
) ENGINE=InnoDB;
