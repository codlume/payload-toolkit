import { spawn } from "node:child_process";

export const runCommand = (command, args) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit" });

    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(
        new Error(
          signal
            ? `${command} terminated with ${signal}`
            : `${command} exited with status ${String(code)}`,
        ),
      );
    });
  });
