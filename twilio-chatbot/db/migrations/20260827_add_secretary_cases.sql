-- Casos de secretaría que no son una cita agendada (ej: revisión de foto
-- postoperatoria, soporte postquirúrgico general). Antes solo existían como
-- un mensaje de WhatsApp enviado a la secretaria -- si ese mensaje fallaba,
-- o si la secretaria simplemente lo perdía entre el resto de mensajes, no
-- había ningún registro consultable desde el panel. Ejecutar una vez en la
-- base existente (local y luego Hostinger).
CREATE TABLE IF NOT EXISTS secretary_cases (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  patient_phone VARCHAR(32) NOT NULL,
  patient_name VARCHAR(255) NULL,
  patient_document VARCHAR(64) NULL,
  reason VARCHAR(64) NOT NULL,
  note TEXT NULL,
  media_url VARCHAR(1024) NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'PENDING',
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  resolved_at TIMESTAMP NULL,
  resolved_by VARCHAR(32) NULL,
  KEY idx_secretary_cases_status (status),
  KEY idx_secretary_cases_phone (patient_phone)
) ENGINE=InnoDB;
