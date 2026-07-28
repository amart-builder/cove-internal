import { httpRouter } from "convex/server";
import { httpAction } from "./_generated/server";
import { api } from "./_generated/api";
import { auth } from "./auth";

const http = httpRouter();

// Convex Auth routes (sign-in, sign-up, sign-out, etc.)
auth.addHttpRoutes(http);

// Convert string priority to numeric
function priorityToNumber(p: unknown): number {
  if (typeof p === "number") return p;
  const map: Record<string, number> = { high: 1, medium: 2, low: 3, flag: 1, reply: 1, follow_up: 2, archive: 3, review: 2 };
  return map[String(p).toLowerCase()] ?? 2;
}

// Helper to check bearer token auth
function checkAuth(req: Request): boolean {
  const authHeader = req.headers.get("Authorization");
  if (!authHeader?.startsWith("Bearer ")) return false;
  const token = authHeader.slice(7);
  // COVE_API_SECRET (or the legacy FORGE_API_SECRET) is set as a Convex environment variable
  // Convex bundles this file on its own, so it cannot import src/lib/env.
  // The COVE_/FORGE_ fallback is spelled out here instead.
  const secret = process.env.COVE_API_SECRET ?? process.env.FORGE_API_SECRET;
  return token === secret;
}

// POST /api/triage — batch email triage items
http.route({
  path: "/api/triage",
  method: "POST",
  handler: httpAction(async (ctx, req) => {
    if (!checkAuth(req)) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: { "Content-Type": "application/json" } });
    }

    const body = await req.json();
    const { emails, summary } = body;

    if (!Array.isArray(emails)) {
      return new Response(JSON.stringify({ error: "emails must be an array" }), { status: 400, headers: { "Content-Type": "application/json" } });
    }

    const now = Date.now();

    for (const email of emails) {
      const emailId = await ctx.runMutation(api.emails.createFromTriage, {
        senderName: email.sender_name ?? undefined,
        senderEmail: email.sender_email ?? undefined,
        subject: email.subject ?? undefined,
        summary: email.summary ?? undefined,
        context: email.context ?? undefined,
        recommendedAction: email.recommended_action ?? "review",
        draftResponse: email.draft_response ?? undefined,
        priority: priorityToNumber(email.priority),
        createdAt: now,
      });

      await ctx.runMutation(api.emailActions.create, {
        emailItemId: emailId,
        actionType: "triaged",
        description: `Auto-triaged: ${email.subject ?? "No subject"} → ${email.recommended_action ?? "review"}`,
      });
    }

    // Update app state
    await ctx.runMutation(api.appState.set, {
      key: "last_email_triage",
      value: new Date(now).toISOString(),
    });

    if (summary) {
      await ctx.runMutation(api.appState.set, {
        key: "email_triage_summary",
        value: summary,
      });
    }

    return new Response(JSON.stringify({ success: true, count: emails.length }), { status: 200, headers: { "Content-Type": "application/json" } });
  }),
});

// POST /api/contacts — create/update contact
http.route({
  path: "/api/contacts",
  method: "POST",
  handler: httpAction(async (ctx, req) => {
    if (!checkAuth(req)) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: { "Content-Type": "application/json" } });
    }

    const body = await req.json();
    const id = await ctx.runMutation(api.contacts.create, {
      name: body.name,
      email: body.email ?? undefined,
      phone: body.phone ?? undefined,
      company: body.company ?? undefined,
      role: body.role ?? undefined,
      linkedin: body.linkedin ?? undefined,
      location: body.location ?? undefined,
      tier: body.tier ?? undefined,
      tags: body.tags ?? undefined,
      howWeMet: body.how_we_met ?? undefined,
      notes: body.notes ?? undefined,
    });

    return new Response(JSON.stringify({ success: true, id }), { status: 200, headers: { "Content-Type": "application/json" } });
  }),
});

// GET /api/status — return app state
http.route({
  path: "/api/status",
  method: "GET",
  handler: httpAction(async (ctx, req) => {
    if (!checkAuth(req)) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: { "Content-Type": "application/json" } });
    }

    const state = await ctx.runQuery(api.appState.list);
    return new Response(JSON.stringify({ state }), { status: 200, headers: { "Content-Type": "application/json" } });
  }),
});

// CORS preflight for all routes
http.route({
  path: "/api/triage",
  method: "OPTIONS",
  handler: httpAction(async () => {
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization",
      },
    });
  }),
});

http.route({
  path: "/api/contacts",
  method: "OPTIONS",
  handler: httpAction(async () => {
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization",
      },
    });
  }),
});

http.route({
  path: "/api/status",
  method: "OPTIONS",
  handler: httpAction(async () => {
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization",
      },
    });
  }),
});

export default http;
