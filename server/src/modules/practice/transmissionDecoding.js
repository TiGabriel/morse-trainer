/**
 * Server-side bridge into the Morse Transmitter's pure decoding/timing
 * engine (client/public/js/morse-transmitter-core.js). Requires that
 * exact production file rather than a duplicated copy — the file is
 * dual browser-global/CommonJS specifically so both the browser and this
 * server module load the identical logic (same pattern the morse-receiver
 * tests already established for morse-receiver-core.js).
 *
 * Used to authoritatively re-derive the transmitted text + timing stats
 * from a student's raw key-press element log — the server never trusts
 * a client-reported "decodedText" string, same "recompute from the raw
 * input" rule every other exercise type in this app already follows.
 */
const path = require('path');

const CLIENT_JS_DIR = path.resolve(__dirname, '..', '..', '..', '..', 'client', 'public', 'js');
const { analyzeElementLog } = require(path.join(CLIENT_JS_DIR, 'morse-transmitter-core.js'));

module.exports = { analyzeElementLog };
