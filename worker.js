// Cloudflare Worker entry: serves /api/* from the payment handlers.
// Everything else (the website in /public) is served directly as static assets.
import * as initialize from "../functions/api/korapay-initialize.js";
import * as verify from "../functions/api/korapay-verify.js";
import * as webhook from "../functions/api/korapay-webhook.js";

const routes = {
  "/api/korapay-initialize": { POST: initialize.onRequestPost },
  "/api/korapay-verify": { GET: verify.onRequestGet },
  "/api/korapay-webhook": { POST: webhook.onRequestPost },
};

export default {
  async fetch(request, env) {
    const route = routes[new URL(request.url).pathname];
    if (!route) return new Response("Not found", { status: 404 });
    const handler = route[request.method];
    if (!handler) return new Response("Method not allowed", { status: 405 });
    return handler({ request, env });
  },
};
