const type = "@codlume/payload-live-preview";
type Message =
  | { type: typeof type; event: "ready"; ack?: true }
  | { type: typeof type; event: "locate"; ids: string[] };
export const diagnostics =
  (side: "admin" | "preview", debug: boolean) => (event: string, detail?: string[]) => {
    if (debug) console.debug(`[${type}:${side}] ${event}`, ...(detail ? [detail] : []));
  };

/** Owns the handshake and validates messages before calling either adapter. */
export const connect = ({
  peer,
  origin,
  onConnect,
  onLocate,
  log,
}: {
  peer: Window;
  origin: string;
  onConnect: () => void;
  onLocate: (ids: string[]) => void;
  log: ReturnType<typeof diagnostics>;
}) => {
  let connected = false;
  const post = (message: Message) => peer.postMessage(message, origin);
  const receive = (event: MessageEvent<unknown>) => {
    const data = event.data;
    if (typeof data !== "object" || data === null || !("type" in data) || data.type !== type)
      return;
    if (event.source !== peer || event.origin !== origin) {
      log("rejected plugin message: source or origin");
      return;
    }
    if (
      !("event" in data) ||
      !(
        (data.event === "ready" && (!("ack" in data) || data.ack === true)) ||
        (data.event === "locate" &&
          "ids" in data &&
          Array.isArray(data.ids) &&
          data.ids.length > 0 &&
          data.ids.every((id) => typeof id === "string" && id.length > 0))
      )
    ) {
      log("rejected plugin message: malformed payload");
      return;
    }
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- validated all message fields above
    const message = data as Message;
    if (message.event === "ready") {
      if (!connected) {
        connected = true;
        log("connected");
        onConnect();
      }
      if (!message.ack) post({ type, event: "ready", ack: true });
    } else if (connected) {
      log("received locate", message.ids);
      onLocate(message.ids);
    } else log("dropped locate before connection", message.ids);
  };
  window.addEventListener("message", receive);
  post({ type, event: "ready" });
  return {
    locate(ids: string[]) {
      if (!connected) {
        log("dropped locate before connection", ids);
        return false;
      }
      post({ type, event: "locate", ids });
      log("sent locate", ids);
      return true;
    },
    dispose() {
      window.removeEventListener("message", receive);
      connected = false;
      log("reset");
    },
  };
};
