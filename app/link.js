// The laptop's address on the phone's Personal Hotspot, over USB or Bluetooth.
// iOS hands out 172.20.10.2 upward, so a laptop on both links holds two of these.
export const HOTSPOT_HOSTS = ['172.20.10.2', '172.20.10.3', '172.20.10.4', '172.20.10.5'];

const RANK = { USB: 0, 'Wi-Fi': 1, LAN: 1, Bluetooth: 2 };
const rank = (link) => RANK[link] ?? 3;

// Probes every host at once and resolves {ws, link} for the lowest-latency link that answered,
// or null. USB wins straight away; anything else waits briefly in case USB answers too.
export function findBestLink(hosts, port, { WS = WebSocket, settleMs = 400, timeoutMs = 3000 } = {}) {
  return new Promise((resolve) => {
    const sockets = [...new Set(hosts)].filter(Boolean).map((host) => new WS(`ws://${host}:${port}`));
    let best = null;
    let done = false;
    let settle = null;

    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(settle);
      clearTimeout(limit);
      for (const socket of sockets) {
        socket.onmessage = null;
        if (socket !== best?.ws) socket.close();
      }
      resolve(best);
    };
    const limit = setTimeout(finish, timeoutMs);

    for (const socket of sockets) {
      socket.onmessage = ({ data }) => {
        let link;
        try {
          link = JSON.parse(data).link;
        } catch {
          return;
        }
        if (!link) return;
        if (!best || rank(link) < rank(best.link)) best = { ws: socket, link };
        if (best.link === 'USB') finish();
        else settle ??= setTimeout(finish, settleMs);
      };
    }
  });
}
