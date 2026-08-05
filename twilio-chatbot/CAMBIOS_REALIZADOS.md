# Cambios realizados

## Teleconsulta

- El botón de Teleconsulta del menú principal utiliza el Content SID `HX18e7c4eb9b23f2fbb53b37f1c2520bed`.
- Se conserva el estado independiente `TELECONSULTA`.
- Se soportan los payloads `teleconsulta_agendar`, `teleconsulta_requisitos`, `teleconsulta_info`, `teleconsulta_secretaria` y `teleconsulta_volver_menu`.
- El flujo conserva el origen `TELECONSULTA` al entrar al agendamiento.

## IA global en agendamiento

La IA ya no está limitada a Teleconsulta. Se activa en todos los accesos que terminan en el estado `AGENDAR`:

- Agendar cita desde el menú principal.
- Agendar nueva consulta desde Gestión de citas.
- Agendar desde Información y costos.
- Agendar cita posoperatoria.
- Agendar teleconsulta.
- Reinicio o entrada directa al estado global de agendamiento.

### Comportamiento incorporado

- El usuario puede escribir una fecha exacta en formato `DD/MM`.
- También puede expresar preferencias naturales, por ejemplo:
  - `lo más pronto posible`
  - `la próxima semana en la tarde`
  - `por la mañana`
  - `después de las 3`
  - `recomiéndame un horario`
- La IA únicamente ordena candidatos construidos con disponibilidad real del sistema.
- Se muestran máximo tres recomendaciones.
- Antes de aceptar una recomendación, el sistema valida nuevamente que el horario continúe libre.
- Después de escoger una fecha, también puede recomendar horas dentro de esa fecha.
- Se generan recomendaciones administrativas de preparación para cualquier modalidad.
- Se filtran diagnósticos, medicamentos, tratamientos, síntomas e instrucciones clínicas.
- Si Azure OpenAI no está disponible, el flujo utiliza un orden determinístico y continúa funcionando.

## Configuración

```env
AI_GLOBAL_SCHEDULING_ENABLED=true
TWILIO_TELECONSULTA_TEMPLATE_SID=HX18e7c4eb9b23f2fbb53b37f1c2520bed
SALUDTOOLS_TELECONSULTATION_APPOINTMENT_TYPE=Teleconsulta / lectura de estudios
```

Para desactivar temporalmente la recomendación global puede configurarse:

```env
AI_GLOBAL_SCHEDULING_ENABLED=false
```

## Archivos principales modificados

- `states/agendar.state.js`
- `states/menu.state.js`
- `states/gestionCitas.state.js`
- `states/infoCostos.state.js`
- `states/postSurgery.state.js`
- `states/teleconsulta.state.js`
- `CONFIGURACION_NUEVA.env.example`

## Pruebas

- Verificación de sintaxis de los archivos JavaScript modificados.
- 11 pruebas automatizadas aprobadas.
- Pruebas de entrada global desde los cinco accesos principales.
- Prueba de frase natural para recomendar fecha.
- Prueba de recomendación de hora dentro de una fecha seleccionada.
- Pruebas existentes de la plantilla y el estado de Teleconsulta.

## Corrección: citas escritas directamente desde el menú

- El estado `MENU` ahora detecta solicitudes con intención de cita y fecha, por ejemplo: `citas para jueves 13 de agosto`.
- La fecha se normaliza a `DD/MM` y se conserva durante la identificación del paciente.
- Cuando el usuario termina el filtro de columna, el flujo consulta automáticamente los horarios de la fecha guardada.
- Las palabras de gestión como `cancelar`, `reagendar`, `cambiar` o `mover` no se interpretan como una cita nueva.
- Se agregaron pruebas para la frase exacta reportada y para la reutilización automática de `13/08`.
