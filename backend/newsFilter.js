function parseCustomBlocks(raw, now) {
    if (!raw) return null;

    const timestamp = now.getTime();
    const blocks = String(raw).split(',').map(item => item.trim()).filter(Boolean);

    for (const block of blocks) {
        const [startRaw, endRaw] = block.split('/').map(item => item && item.trim());
        if (!startRaw || !endRaw) continue;

        const start = new Date(startRaw).getTime();
        const end = new Date(endRaw).getTime();
        if (Number.isFinite(start) && Number.isFinite(end) && timestamp >= start && timestamp <= end) {
            return `Custom USD news block ${startRaw} to ${endRaw}`;
        }
    }

    return null;
}

function isFirstFriday(now) {
    if (now.getUTCDay() !== 5) return false;
    return now.getUTCDate() <= 7;
}

function isUsdNewsBlocked(now = new Date(), env = process.env) {
    if (env.NEWS_FILTER_ENABLED === 'false') {
        return { blocked: false };
    }

    const customReason = parseCustomBlocks(env.USD_NEWS_BLOCKS, now);
    if (customReason) {
        return { blocked: true, reason: customReason };
    }

    const hour = now.getUTCHours();
    const minute = now.getUTCMinutes();
    const timeInMinutes = hour * 60 + minute;

    if (env.USD_NFP_FILTER !== 'false' && isFirstFriday(now) && timeInMinutes >= 12 * 60 && timeInMinutes <= 14 * 60) {
        return { blocked: true, reason: 'First-Friday NFP risk window (12:00-14:00 UTC)' };
    }

    return { blocked: false };
}

module.exports = { isUsdNewsBlocked };
