const ALL_SLOTS = [
    "08:00",
    "08:20",
    "08:40",
    "09:00",
    "09:20",
    "09:40",
    "10:00",
    "10:20",
    "10:40",
    "11:00",
    "11:20",
    "11:40",
    "14:00",
    "14:20",
    "14:40",
    "15:00",
    "15:20",
    "15:40",
    "16:00",
    "16:20",
    "16:40",
];

function getTimeSlots(page = 0, pageSize = 6) {
    const start = page * pageSize;
    return ALL_SLOTS.slice(start, start + pageSize);
}

module.exports = {
    getTimeSlots,
};
