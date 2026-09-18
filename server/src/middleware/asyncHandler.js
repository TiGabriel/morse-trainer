/**
 * Wraps an async route handler so a rejected promise is forwarded to
 * Express's error-handling middleware via next(err), instead of becoming
 * an unhandled rejection. Express 4 only catches SYNCHRONOUS throws from
 * route handlers automatically — an async function that rejects (e.g. a
 * failed bcrypt hash, a DB error inside an awaited call) is not caught,
 * and the request would otherwise hang forever with no response ever
 * sent to the client.
 */
function asyncHandler(fn) {
    return function wrapped(req, res, next) {
        try {
            Promise.resolve(fn(req, res, next)).catch(next);
        } catch (err) {
            next(err);
        }
    };
}

module.exports = asyncHandler;
