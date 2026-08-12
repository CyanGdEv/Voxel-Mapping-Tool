import { parentPort, workerData } from "node:worker_threads";
import { serializeChunkJob } from "./mcworld.mjs";

if (!parentPort) throw new Error("mcworld chunk worker requires a parent port");

parentPort.on("message", (message) => {
  if (message?.type === "stop") {
    parentPort.close();
    return;
  }
  if (message?.type !== "job") return;
  const { index, job } = message;
  try {
    const result = serializeChunkJob(workerData, job);
    parentPort.postMessage({ type: "result", index, result });
  } catch (error) {
    parentPort.postMessage({
      type: "error",
      index,
      error: error?.stack || error?.message || String(error)
    });
  }
});
