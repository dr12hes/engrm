export const EngrmPlugin = async ({ client, directory, worktree, project }) => {
  const projectLabel = project?.name ?? directory ?? worktree ?? "unknown";

  try {
    await client.app.log({
      body: {
        service: "engrm-opencode",
        level: "info",
        message: "Engrm OpenCode plugin initialized",
        extra: { project: projectLabel },
      },
    });
  } catch {
    // Best-effort only
  }

  return {
    event: async ({ event }) => {
      if (!event?.type) return;
      if (event.type === "session.created" || event.type === "session.compacted") {
        try {
          await client.app.log({
            body: {
              service: "engrm-opencode",
              level: "info",
              message: `Observed OpenCode event: ${event.type}`,
              extra: { project: projectLabel },
            },
          });
        } catch {
          // Best-effort only
        }
      }
    },

    "experimental.session.compacting": async (_input, output) => {
      output.context.push(`
## Engrm Continuity

Before finalizing the compaction summary, preserve the active working thread using Engrm's continuity model.

Prefer these Engrm tools when continuity is unclear:
1. \`resume_thread\`
2. \`list_recall_items\`
3. \`load_recall_item\`
4. \`repair_recall\`

Carry forward:
- the current task and status
- the current thread in one sentence
- the next actions
- the hot files or touched files
- the best exact recall key to reopen, if one is available

Do not collapse the session into generic status language if a more specific current thread exists.
      `.trim());
    },
  };
};

export default EngrmPlugin;
