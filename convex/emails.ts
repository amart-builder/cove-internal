import { query, mutation } from "./_generated/server";
import { v } from "convex/values";

export const list = query({
  args: { status: v.optional(v.string()) },
  handler: async (ctx, args) => {
    if (args.status) {
      return await ctx.db
        .query("emailItems")
        .withIndex("by_status", (q) => q.eq("status", args.status as "pending" | "actioned" | "dismissed"))
        .order("desc")
        .collect();
    }
    return await ctx.db.query("emailItems").order("desc").collect();
  },
});

export const get = query({
  args: { id: v.id("emailItems") },
  handler: async (ctx, args) => {
    return await ctx.db.get(args.id);
  },
});

export const update = mutation({
  args: {
    id: v.id("emailItems"),
    status: v.optional(v.string()),
    draftResponse: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const { id, ...fields } = args;

    const patch: Record<string, unknown> = {};

    if (fields.status !== undefined) {
      patch.status = fields.status;
      if (fields.status === "actioned" || fields.status === "dismissed") {
        patch.actionedAt = Date.now();
      }
    }

    if (fields.draftResponse !== undefined) {
      patch.draftResponse = fields.draftResponse;
    }

    await ctx.db.patch(id, patch);
  },
});

export const createFromTriage = mutation({
  args: {
    senderName: v.optional(v.string()),
    senderEmail: v.optional(v.string()),
    subject: v.optional(v.string()),
    summary: v.optional(v.string()),
    context: v.optional(v.string()),
    recommendedAction: v.optional(v.string()),
    draftResponse: v.optional(v.string()),
    priority: v.optional(v.float64()),
    createdAt: v.optional(v.float64()),
  },
  handler: async (ctx, args) => {
    const now = args.createdAt ?? Date.now();
    const action = args.recommendedAction ?? "review";
    const validActions = ["reply", "archive", "follow_up", "delegate", "flag", "review"] as const;
    const recommendedAction = validActions.includes(action as typeof validActions[number])
      ? (action as typeof validActions[number])
      : "review";

    return await ctx.db.insert("emailItems", {
      senderName: args.senderName,
      senderEmail: args.senderEmail,
      subject: args.subject,
      summary: args.summary,
      context: args.context,
      recommendedAction,
      draftResponse: args.draftResponse,
      priority: args.priority ?? 2,
      status: "pending",
      createdAt: now,
    });
  },
});

export const send = mutation({
  args: { id: v.id("emailItems") },
  handler: async (ctx, args) => {
    // NOTE: Convex mode does not actually send mail. Real sending lives in the
    // local path (restricted Google gateway). This only marks
    // the item handled. Do not use Convex mode for email until this calls a
    // sender, or it will report success without sending.
    await ctx.db.patch(args.id, {
      status: "actioned",
      actionedAt: Date.now(),
    });

    await ctx.db.insert("emailActions", {
      emailItemId: args.id,
      actionType: "sent",
      description: "Email response sent",
      createdAt: Date.now(),
    });
  },
});
