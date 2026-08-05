# Plantillas Twilio propuestas para agendamiento global con IA

Estas plantillas son opcionales. La lógica ya acepta texto libre, pero los botones ayudan a que el usuario descubra la función.

## 1. Selección global de fecha

**Tipo recomendado:** `twilio/quick-reply`

**Nombre sugerido:** `agenda_global_fecha_ia`

**Cuerpo:**

> ¿Cómo deseas elegir la fecha de tu cita?
>
> Puedo recomendarte opciones verificadas como disponibles o puedes escribir una fecha en formato DD/MM.

| Botón visible | Payload / ID |
|---|---|
| Lo más pronto | `agenda_recomendar_proxima` |
| Preferir mañana | `agenda_recomendar_manana` |
| Escribir fecha | `agenda_escribir_fecha` |

El detector global reconoce esos payloads porque contienen la intención `recomendar`.

## 2. Selección global de horario

**Tipo recomendado:** `twilio/quick-reply`

**Nombre sugerido:** `agenda_global_hora_ia`

**Cuerpo:**

> Encontré horarios disponibles para {{1}}.
>
> Puedes ver la lista completa o pedirme una recomendación según el momento del día que prefieras.

| Botón visible | Payload / ID |
|---|---|
| Recomendar mañana | `agenda_recomendar_hora_manana` |
| Recomendar tarde | `agenda_recomendar_hora_tarde` |
| Ver todos | `agenda_ver_horarios` |

## 3. Confirmación de opción recomendada

**Tipo recomendado:** `twilio/quick-reply`

**Nombre sugerido:** `agenda_confirmar_recomendacion_ia`

**Variables:**

- `{{1}}`: fecha.
- `{{2}}`: hora.
- `{{3}}`: modalidad.
- `{{4}}`: motivo operativo de la recomendación.

**Cuerpo:**

> Opción recomendada
>
> Fecha: {{1}}
> Hora: {{2}}
> Modalidad: {{3}}
>
> {{4}}
>
> La disponibilidad se validará nuevamente antes de continuar.

| Botón visible | Payload / ID |
|---|---|
| Elegir opción | `agenda_elegir_recomendacion` |
| Ver alternativas | `agenda_recomendar_otras` |
| Escribir fecha | `agenda_escribir_fecha` |

## Alcance de seguridad

La IA puede interpretar preferencias de agenda, ordenar fechas y horas reales y generar recomendaciones administrativas de preparación. No debe diagnosticar, recetar, interpretar síntomas ni modificar tratamientos.
