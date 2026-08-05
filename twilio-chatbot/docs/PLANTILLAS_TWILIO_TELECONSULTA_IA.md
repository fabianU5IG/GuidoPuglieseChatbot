# Plantillas Twilio propuestas: Teleconsulta e IA de agendamiento

## 1. Plantilla principal de teleconsulta — integrada

**Content SID configurado:** `HX18e7c4eb9b23f2fbb53b37f1c2520bed`

**Tipo recomendado:** `twilio/quick-reply`

**Nombre sugerido:** `menu_teleconsulta_guido`

**Cuerpo:**

> Teleconsulta / lectura de estudios
>
> Puedes agendar una atención para revisión de estudios, consultar los requisitos o solicitar apoyo de la secretaria.
>
> Selecciona una opción para continuar.

**Botones y payloads exactos:**

| Botón visible | Payload / ID |
|---|---|
| Agendar consulta | `teleconsulta_agendar` |
| Ver requisitos | `teleconsulta_requisitos` |
| Hablar secretaría | `teleconsulta_secretaria` |

El código también reconoce como alternativa escrita `Información teleconsulta`, con payload sugerido `teleconsulta_info`, y `Volver al menú`, con payload `teleconsulta_volver_menu`.

> Recomendación: mantener los títulos de los botones en 20 caracteres o menos y usar los payloads exactamente como aparecen en esta tabla.

## 2. Plantilla opcional para activar recomendaciones de IA

Esta plantilla puede reemplazar en el futuro la pregunta de fecha escrita. Para conectarla solo hace falta crearla en Twilio y agregar su SID al código.

**Tipo recomendado:** `twilio/quick-reply`

**Nombre sugerido:** `agenda_recomendacion_ia`

**Cuerpo:**

> ¿Cómo deseas elegir tu cita?
>
> Puedo mostrarte opciones calculadas con disponibilidad real o puedes escribir una fecha en formato DD/MM.

**Botones y payloads exactos:**

| Botón visible | Payload / ID |
|---|---|
| Recomendar mañana | `agenda_recomendar_manana` |
| Recomendar tarde | `agenda_recomendar_tarde` |
| Escribir fecha | `agenda_escribir_fecha` |

Los dos primeros payloads ya son compatibles con el detector de recomendaciones incluido en el código.

## 3. Plantilla opcional de preparación de la cita

**Tipo recomendado:** `twilio/quick-reply`

**Nombre sugerido:** `preparacion_cita_ia`

**Variables sugeridas:**

- `{{1}}`: nombre del paciente.
- `{{2}}`: modalidad.
- `{{3}}`: fecha.
- `{{4}}`: hora.
- `{{5}}`: recomendaciones administrativas generadas.

**Cuerpo:**

> Listo, {{1}}.
>
> Modalidad: {{2}}
> Fecha: {{3}}
> Hora: {{4}}
>
> Recomendaciones de preparación:
> {{5}}
>
> Estas recomendaciones son administrativas y no reemplazan la valoración médica.

**Botones y payloads sugeridos:**

| Botón visible | Payload / ID |
|---|---|
| Continuar | `agenda_continuar` |
| Cambiar fecha | `agenda_cambiar_fecha` |
| Volver al menú | `volver_menu` |

## Variables de entorno nuevas u opcionales

```env
TWILIO_TELECONSULTA_TEMPLATE_SID=HX18e7c4eb9b23f2fbb53b37f1c2520bed
SALUDTOOLS_TELECONSULTATION_APPOINTMENT_TYPE=Teleconsulta / lectura de estudios
# Configurar solo si SaludTools tiene una modalidad remota válida para esta cuenta.
SALUDTOOLS_TELECONSULTATION_MODALITY=CONVENTIONAL
```

Si `SALUDTOOLS_TELECONSULTATION_MODALITY` no está definida, el sistema conserva la modalidad general configurada en `SALUDTOOLS_APPOINTMENT_MODALITY`. Esto evita enviar un valor no reconocido por SaludTools.

## Comportamiento de IA incorporado

- Interpreta respuestas libres de los usuarios durante el agendamiento.
- Cuando el usuario escribe `RECOMENDAR`, busca fechas y horas reales disponibles en la base de datos.
- Puede priorizar mañana o tarde según el mensaje del usuario.
- La IA solo puede ordenar opciones entregadas por el sistema; no puede inventar disponibilidad.
- Antes de aceptar la opción recomendada, el sistema consulta nuevamente si el horario sigue libre.
- Genera tres recomendaciones administrativas de preparación, sin diagnósticos, medicamentos ni indicaciones clínicas.
- Si Azure OpenAI no responde, el flujo continúa con recomendaciones determinísticas de respaldo.
