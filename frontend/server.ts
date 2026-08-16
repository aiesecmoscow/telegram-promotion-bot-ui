import index from "./index.html";

const PORT = parseInt(process.env.PORT ?? "8080");
const BACKEND = process.env.BACKEND_URL ?? "http://localhost:8000";
const isProd = process.env.NODE_ENV === "production";

const STATIC_CACHEABLE = /\.(?:js|css|woff2?|ttf|eot|svg|png|jpe?g|gif|ico|webp|avif)$/;

async function proxyToBackend(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const target = `${BACKEND}${url.pathname.replace(/^\/api/, "")}${url.search}`;
  return fetch(target, {
    method: req.method,
    headers: req.headers,
    body: req.body,
    duplex: "half",
  } as RequestInit);
}

function withCacheHeaders(path: string, file: Blob): Response {
  const headers: Record<string, string> = {};
  if (STATIC_CACHEABLE.test(path)) {
    headers["Cache-Control"] = "public, max-age=31536000, immutable";
  }
  return new Response(file, { headers });
}

Bun.serve({
  port: PORT,
  development: !isProd,
  routes: {
    "/api/*": proxyToBackend,
    "/*": isProd
      ? async (req) => {
          const url = new URL(req.url);
          const path = url.pathname === "/" ? "/index.html" : url.pathname;
          if (path.includes("..")) return new Response("Bad request", { status: 400 });
          const file = Bun.file(`./public${path}`);
          if (await file.exists()) return withCacheHeaders(path, file);
          const fallback = Bun.file("./public/index.html");
          return new Response(fallback, { headers: { "Content-Type": "text/html" } });
        }
      : index,
  },
});

console.log(`Frontend listening on http://localhost:${PORT}, backend=${BACKEND}, prod=${isProd}`);