import type { diagnostics } from "./channel.ts";

const noop = () => {};

/** One replaceable locate, including lazy mounting and collapse transition delays. */
export const createLocateWork = (log: ReturnType<typeof diagnostics>) => {
  let cancel = noop;
  return {
    cancel: () => cancel(),
    locate(ids: string[], resolve: () => boolean | number) {
      cancel();
      let observer: MutationObserver | undefined;
      let wake: ReturnType<typeof setTimeout> | undefined;
      let waiting = false;
      let missing = false;
      const timeout = setTimeout(() => {
        cancel();
        log("target timeout", ids);
      }, 2000);
      cancel = () => {
        observer?.disconnect();
        clearTimeout(timeout);
        clearTimeout(wake);
      };
      const attempt = () => {
        if (waiting) return;
        const result = resolve();
        if (result === true) {
          cancel();
          return;
        }
        if (!observer) {
          observer = new MutationObserver(attempt);
          observer.observe(document.body, { childList: true, subtree: true, attributes: true });
        }
        if (typeof result === "number") {
          waiting = true;
          wake = setTimeout(() => {
            waiting = false;
            attempt();
          }, result);
        } else if (!missing) {
          missing = true;
          log("missing target", ids);
        }
      };
      attempt();
    },
  };
};
