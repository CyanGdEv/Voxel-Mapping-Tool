import test from "node:test";
import { execFileSync } from "node:child_process";

test("LibreDWG bootstrap script has valid bash syntax", () => {
  execFileSync("bash", ["-n", "scripts/build-libredwg.sh"], {
    stdio: ["ignore", "pipe", "pipe"]
  });
});
