// services/doctoralia.service.js
const { DOCTORALIA } = require("../constants");

function buildDoctoraliaDateTime(date, time) {
    // date: YYYY-MM-DD
    // time: HH:mm
    return `${date}T${time}:00${DOCTORALIA.TIMEZONE_OFFSET}`;
}

function buildDoctoraliaUrl(date, time) {
    const dateTime = buildDoctoraliaDateTime(date, time);

    return (
        `https://www.doctoralia.co/booking/seleccionar-fecha/` +
        `${DOCTORALIA.DOCTOR_ID}/` +
        `${DOCTORALIA.ADDRESS_ID}/` +
        `${dateTime}/` +
        `${DOCTORALIA.SPECIALTY_ID}`
    );
}

module.exports = {
    buildDoctoraliaUrl,
};
