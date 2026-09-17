const logger = require('../logger');

/**
 * Logs every incoming HTTP request once it finishes, with method, path,
 * status code, and duration. Simple substitute for a package like morgan,
 * kept in-house to avoid an extra dependency for this small a need.
 */
function requestLogger(req, res, next) {
    const startedAt = Date.now();

    res.on('finish', () => {
        const durationMs = Date.now() - startedAt;
        logger.info(`${req.method} ${req.originalUrl} -> ${res.statusCode} (${durationMs}ms) [${req.ip}]`);
    });

    next();
}

module.exports = requestLogger;
