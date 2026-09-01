import index from "./index.html";

Bun.serve({
  port: 4173,
  routes: { "/": index },
});
