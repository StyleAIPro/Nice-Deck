const RECONNECT_DELAYS = [250, 500, 1000, 2000, 5000];

export function connectEvents({ url, token, onEvent = () => {}, onState = () => {} }) {
  let socket;
  let reconnectTimer;
  let reconnectIndex = 0;
  let disposed = false;
  let state;

  const setState = next => {
    if (state === next) return;
    state = next;
    onState(next);
  };

  const connect = () => {
    if (disposed) return;
    const endpoint = new URL(url, globalThis.location?.href);
    endpoint.searchParams.set('token', token);
    socket = new WebSocket(endpoint);
    socket.addEventListener('open', () => {
      reconnectIndex = 0;
      setState('online');
    });
    socket.addEventListener('message', event => {
      try {
        onEvent(JSON.parse(event.data));
      } catch {
        // 非 JSON 事件不属于 Deck 协议，安全忽略。
      }
    });
    socket.addEventListener('close', () => {
      if (disposed) return;
      setState('offline');
      const delay = RECONNECT_DELAYS[Math.min(reconnectIndex, RECONNECT_DELAYS.length - 1)];
      reconnectIndex += 1;
      reconnectTimer = setTimeout(connect, delay);
    });
  };

  setState('offline');
  connect();

  return {
    send(message) {
      if (socket?.readyState !== WebSocket.OPEN) return false;
      socket.send(JSON.stringify(message));
      return true;
    },
    close() {
      disposed = true;
      clearTimeout(reconnectTimer);
      socket?.close();
    },
  };
}
