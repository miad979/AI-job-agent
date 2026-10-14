import "dotenv/config";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { createApp, openDb } from "./app.ts";

const file = process.env.DB_PATH ?? "data/orbit.db";
if (file !== ":memory:") mkdirSync(path.dirname(file), { recursive: true });
const app = createApp({ db: openDb(file), staticDir: path.resolve("dist") });
const port = Number(process.env.PORT ?? 8787);
app.listen(port, () => console.log(`Orbit API listening on http://localhost:${port}`));
