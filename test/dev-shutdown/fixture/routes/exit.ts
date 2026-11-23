import { defineEventHandler } from "h3";

export default defineEventHandler(() => {
  // Simulates a crashing dev worker
  // eslint-disable-next-line unicorn/no-process-exit
  setTimeout(() => process.exit(1), 50);
  return "exiting";
});
