-- Ejecutar una vez en la base existente (local y luego Hostinger).
CREATE TABLE IF NOT EXISTS post_surgery_media (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  public_token CHAR(64) NOT NULL,
  patient_phone VARCHAR(32) NULL,
  patient_name VARCHAR(255) NULL,
  patient_document VARCHAR(64) NULL,
  note TEXT NULL,
  content_type VARCHAR(100) NOT NULL,
  file_extension VARCHAR(12) NOT NULL,
  image_data LONGBLOB NOT NULL,
  byte_size BIGINT UNSIGNED NOT NULL,
  public_url VARCHAR(1024) NOT NULL,
  expires_at DATETIME NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_post_surgery_media_token (public_token),
  KEY idx_post_surgery_media_expiry (expires_at),
  KEY idx_post_surgery_media_phone (patient_phone)
) ENGINE=InnoDB;
