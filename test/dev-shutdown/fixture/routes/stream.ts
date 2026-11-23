import { createEventStream, defineEventHandler } from "h3";

export default defineEventHandler((event) => {
  const stream = createEventStream(event);
  const interval = setInterval(() => {
    stream.push(String(process.env.NITRO_DEV_WORKER_ID));
  }, 100);
  stream.onClosed(() => clearInterval(interval));
  return stream.send();
});
