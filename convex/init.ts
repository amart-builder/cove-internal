import { mutation } from "./_generated/server";
import { TASK_COLUMNS } from "../src/lib/tasks/columns";

export const seed = mutation({
  args: {},
  handler: async (ctx) => {
    const existing = await ctx.db.query("columns").collect();
    const now = Date.now();
    for (const column of TASK_COLUMNS) {
      const exists = existing.some((existingColumn) =>
        column.aliases.some((alias) => alias === existingColumn.name),
      );
      if (!exists) {
        await ctx.db.insert("columns", {
          name: column.name,
          position: column.position,
          createdAt: now,
        });
      }
    }
  },
});
