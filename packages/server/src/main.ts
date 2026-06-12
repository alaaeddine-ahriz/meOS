import { createContext } from "./context.js";
import { startScheduler } from "./scheduler.js";
import { buildServer } from "./server.js";
import { startWatcher } from "./watcher.js";

const ctx = createContext();
const app = await buildServer(ctx);
const watcher = startWatcher(ctx);
const scheduler = startScheduler(ctx);

await app.listen({ port: ctx.config.server.port, host: "127.0.0.1" });

const shutdown = async () => {
  scheduler.stop();
  await watcher.close();
  await app.close();
  ctx.db.close();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
