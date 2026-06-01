/**
 * Utility functions for handling IST (Indian Standard Time) timezone
 */

export const formatTimeIST = (date, format = 'full') => {
    if (!date) return 'N/A';
    
    const dateObj = date instanceof Date ? date : new Date(date);
    
    if (format === 'time-only') {
        return dateObj.toLocaleTimeString('en-IN', {
            timeZone: 'Asia/Kolkata',
            hour: '2-digit', minute: '2-digit', second: '2-digit',
            hour12: false
        });
    } else if (format === 'date-time') {
        return dateObj.toLocaleString('en-IN', {
            timeZone: 'Asia/Kolkata',
            month: 'short', day: 'numeric',
            hour: '2-digit', minute: '2-digit',
            hour12: false
        });
    } else if (format === 'date-only') {
        return dateObj.toLocaleDateString('en-IN', {
            timeZone: 'Asia/Kolkata',
            month: 'short', day: 'numeric', year: 'numeric'
        });
    } else {
        return dateObj.toLocaleString('en-IN', {
            timeZone: 'Asia/Kolkata',
            month: 'short', day: 'numeric', year: 'numeric',
            hour: '2-digit', minute: '2-digit', second: '2-digit',
            hour12: false
        }) + ' IST';
    }
};

export const getISTNow = () => {
    return new Date().toLocaleString('en-IN', {
        timeZone: 'Asia/Kolkata',
        month: 'short', day: 'numeric', year: 'numeric',
        hour: '2-digit', minute: '2-digit', second: '2-digit',
        hour12: false
    });
};

export const getISTDate = () => {
    return new Date().toLocaleDateString('en-IN', {
        timeZone: 'Asia/Kolkata',
        month: 'short', day: 'numeric', year: 'numeric'
    });
};
