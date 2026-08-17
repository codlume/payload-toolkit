import { spawn } from "node:child_process";

export const runCommand = ({ arguments_, command, cwd, env }) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, arguments_, {
      cwd,
      env,
      stdio: "inherit",
    });

    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(new Error(`${command} ${arguments_.join(" ")} exited with ${code ?? signal}`));
    });
  });
