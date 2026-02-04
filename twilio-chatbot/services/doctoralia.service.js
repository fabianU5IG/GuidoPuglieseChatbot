import { DOCTORALIA } from "../constants.js";

function buildDoctoraliaDateTime(date, time) {
    const [day, month] = date.split("/");
    const [hour, minute] = time.split(":");
    const year = new Date().getFullYear();

    return `${year}-${month}-${day}T${hour}:${minute}:00`;
}

export function buildDoctoraliaUrl(date, time, slotId) {
    const dateTime = buildDoctoraliaDateTime(date, time);

    return (
        `https://www.doctoralia.co/booking/seleccionar-fecha/` +
        `${DOCTORALIA.DOCTOR_ID}/` +
        `${DOCTORALIA.ADDRESS_ID}/` +
        `${dateTime}/` +
        `${slotId}`
    );
}
