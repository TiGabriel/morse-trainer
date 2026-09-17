/**
 * Detects the machine's LAN-facing IPv4 address(es) so the server can tell
 * the teacher what URL to give students. Never hardcode an IP — classroom
 * networks vary and DHCP addresses can change between sessions.
 */
const os = require('os');

/**
 * Returns every non-internal IPv4 address found on the machine, tagged
 * with the interface name (e.g. "Ethernet", "Wi-Fi", "eth0").
 */
function getLanAddresses() {
    const interfaces = os.networkInterfaces();
    const candidates = [];

    for (const [name, addrs] of Object.entries(interfaces)) {
        for (const addr of addrs || []) {
            if (addr.family === 'IPv4' && !addr.internal) {
                candidates.push({ interfaceName: name, address: addr.address });
            }
        }
    }

    return candidates;
}

/**
 * Picks the address most likely to be the classroom LAN, preferring
 * common private-network ranges (192.168.x.x, 10.x.x.x, 172.16-31.x.x)
 * over anything else (e.g. VPN or virtual adapters, which sort later).
 * Returns null if the machine has no non-internal IPv4 address at all
 * (e.g. network cable unplugged, Wi-Fi off).
 */
function getPrimaryLanAddress() {
    const candidates = getLanAddresses();
    if (candidates.length === 0) return null;

    const is192 = (a) => /^192\.168\./.test(a.address);
    const is10 = (a) => /^10\./.test(a.address);
    const is172 = (a) => /^172\.(1[6-9]|2\d|3[0-1])\./.test(a.address);

    const preferred = candidates.find(is192) || candidates.find(is10) || candidates.find(is172) || candidates[0];

    return preferred.address;
}

module.exports = { getLanAddresses, getPrimaryLanAddress };
