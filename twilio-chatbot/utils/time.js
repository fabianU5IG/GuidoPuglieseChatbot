// utils/time.js

function pad(num) {
    return num.toString().padStart(2, "0");
}

function generateSlots(startHour, endHour, intervalMinutes) {
    const slots = [];

    for (let hour = startHour; hour < endHour; hour++) {
        for (let min = 0; min < 60; min += intervalMinutes) {
            slots.push(`${pad(hour)}:${pad(min)}`);
        }
    }

    return slots;
}

function getTimeSlots() {
    const interval = 20; // minutos

    // Mañana: 08:00 a 12:00
    const morningSlots = generateSlots(8, 12, interval);

    // Tarde: 14:00 a 17:00
    const afternoonSlots = generateSlots(14, 17, interval);

    return [...morningSlots, ...afternoonSlots];
}

module.exports = {
    getTimeSlots,
};
