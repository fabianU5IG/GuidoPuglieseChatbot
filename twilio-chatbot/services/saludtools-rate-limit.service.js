const MIN_INTERVAL_MS = Number(process.env.SALUDTOOLS_MIN_INTERVAL_MS || 5000); // 5s = 12/min (safe)
const RETRY_429_WAIT_MS = Number(
    process.env.SALUDTOOLS_RETRY_429_WAIT_MS || 70000,
); // 70s

let queue = [];
let processing = false;
let lastRunAt = 0;

function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
}

async function runQueue() {
    if (processing) return;
    processing = true;

    while (queue.length) {
        const job = queue.shift();

        const wait = Math.max(0, MIN_INTERVAL_MS - (Date.now() - lastRunAt));
        if (wait) await sleep(wait);

        lastRunAt = Date.now();

        try {
            const res = await job.fn();

            // 429 -> esperar ventana y reintentar 1 vez
            if (res?.status === 429) {
                await sleep(RETRY_429_WAIT_MS);
                lastRunAt = Date.now();
                const res2 = await job.fn();
                job.resolve(res2);
            } else {
                job.resolve(res);
            }
        } catch (e) {
            job.reject(e);
        }
    }

    processing = false;
}

export function enqueueSaludtoolsRequest(fn) {
    return new Promise((resolve, reject) => {
        queue.push({ fn, resolve, reject });
        runQueue();
    });
}

export function getSaludtoolsQueueSize() {
    return queue.length + (processing ? 1 : 0);
}
