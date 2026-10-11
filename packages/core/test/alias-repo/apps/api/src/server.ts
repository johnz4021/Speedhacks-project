import { Hono } from "hono";
import { getUser } from "~/handlers";
const app = new Hono().basePath("/v1");
app.get("/users/:id", getUser);
app.post("/users", (c) => c.json({}));
export default app;
