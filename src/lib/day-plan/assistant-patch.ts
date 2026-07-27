import { DayPlanInvalidTransition } from "./store-errors";
import type {
  DayPlan,
  DayPlanAssistantProposal,
} from "./types";

const EDITABLE_DECISIONS = new Set(["pending", "preselected", "accepted"]);

function clean(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed || undefined;
}

export function validateAssistantProposal(
  plan: DayPlan,
  proposal: DayPlanAssistantProposal,
): DayPlanAssistantProposal {
  const assistantText = proposal.assistantText?.trim();
  if (!assistantText || assistantText.length > 2000) {
    throw new DayPlanInvalidTransition("Assistant response text is invalid.");
  }
  if (!Array.isArray(proposal.operations) || proposal.operations.length > 12) {
    throw new DayPlanInvalidTransition("Assistant proposal has too many operations.");
  }
  if (typeof proposal.needsClarification !== "boolean") {
    throw new DayPlanInvalidTransition("Assistant clarification state is invalid.");
  }
  const editable = plan.items.filter((item) => EDITABLE_DECISIONS.has(item.decision));
  const editableIds = new Set(editable.map((item) => item.id));
  const createdClientIds = new Set<string>();
  const editedItemIds = new Set<string>();
  const completedItemIds = new Set<string>();
  const hasStructuralChanges = proposal.operations.some(
    (operation) => operation.operation === "create_item" || operation.operation === "complete_item",
  );
  let reorderCount = 0;
  for (const operation of proposal.operations) {
    if (operation.operation === "reorder") {
      if (hasStructuralChanges) {
        throw new DayPlanInvalidTransition("Use item positions when creating or completing work.");
      }
      reorderCount += 1;
      if (reorderCount > 1) {
        throw new DayPlanInvalidTransition("Assistant proposal may reorder only once.");
      }
      if (
        operation.orderedItemIds.length !== editable.length ||
        new Set(operation.orderedItemIds).size !== editable.length ||
        operation.orderedItemIds.some((id) => !editableIds.has(id))
      ) {
        throw new DayPlanInvalidTransition("Assistant order must contain every retained item once.");
      }
      continue;
    }
    if (operation.operation === "create_item") {
      const clientId = clean(operation.clientId);
      const title = clean(operation.title);
      const outcome = clean(operation.outcome);
      const definition = clean(operation.definitionOfDone);
      const project = clean(operation.project);
      if (!clientId || !/^[A-Za-z0-9_-]{1,80}$/.test(clientId) || createdClientIds.has(clientId)) {
        throw new DayPlanInvalidTransition("Assistant create item has an invalid client ID.");
      }
      createdClientIds.add(clientId);
      if (!title || title.length > 240 || !outcome || outcome.length > 1200) {
        throw new DayPlanInvalidTransition("Assistant create item content is invalid.");
      }
      if ((definition?.length ?? 0) > 1200 || (project?.length ?? 0) > 120) {
        throw new DayPlanInvalidTransition("Assistant create item details are too long.");
      }
      if (operation.owner && !(["me", "claude", "together"] as const).includes(operation.owner)) {
        throw new DayPlanInvalidTransition("Assistant create item has an invalid owner.");
      }
      if (operation.priority && !(["low", "medium", "high"] as const).includes(operation.priority)) {
        throw new DayPlanInvalidTransition("Assistant create item has an invalid priority.");
      }
      if (!Number.isInteger(operation.position) || operation.position < 0 || operation.position > 20) {
        throw new DayPlanInvalidTransition("Assistant create item has an invalid position.");
      }
      continue;
    }
    if (!editableIds.has(operation.itemId)) {
      throw new DayPlanInvalidTransition("Assistant proposal references an unavailable item.");
    }
    if (operation.operation === "complete_item") {
      if (completedItemIds.has(operation.itemId)) {
        throw new DayPlanInvalidTransition("Assistant proposal completes an item more than once.");
      }
      completedItemIds.add(operation.itemId);
      continue;
    }
    if (operation.operation === "set_owner") {
      if (!(["me", "claude", "together"] as const).includes(operation.owner)) {
        throw new DayPlanInvalidTransition("Assistant proposal has an invalid owner.");
      }
      continue;
    }
    if (operation.operation !== "edit_item") {
      throw new DayPlanInvalidTransition("Assistant proposal has an unsupported operation.");
    }
    if (editedItemIds.has(operation.itemId)) {
      throw new DayPlanInvalidTransition("Assistant proposal edits an item more than once.");
    }
    editedItemIds.add(operation.itemId);
    const title = operation.title === undefined ? undefined : clean(operation.title);
    const outcome = operation.outcome === undefined ? undefined : clean(operation.outcome);
    const definition = operation.definitionOfDone === null
      ? null
      : operation.definitionOfDone === undefined
        ? undefined
        : clean(operation.definitionOfDone);
    if (operation.title !== undefined && (!title || title.length > 240)) {
      throw new DayPlanInvalidTransition("Assistant item title is invalid.");
    }
    if (operation.outcome !== undefined && (!outcome || outcome.length > 1200)) {
      throw new DayPlanInvalidTransition("Assistant item outcome is invalid.");
    }
    if (definition && definition.length > 1200) {
      throw new DayPlanInvalidTransition("Assistant definition of done is too long.");
    }
    if (operation.position !== undefined &&
      (!Number.isInteger(operation.position) || operation.position < 0 || operation.position > 20)) {
      throw new DayPlanInvalidTransition("Assistant item position is invalid.");
    }
    if (title === undefined && outcome === undefined && definition === undefined && operation.position === undefined) {
      throw new DayPlanInvalidTransition("Assistant edit has no supported fields.");
    }
  }
  if (proposal.needsClarification && proposal.operations.length > 0) {
    throw new DayPlanInvalidTransition("A clarification response cannot also edit the plan.");
  }
  return structuredClone({ ...proposal, assistantText });
}

export function applyAssistantProposal(
  plan: DayPlan,
  proposal: DayPlanAssistantProposal,
  options?: { now?: string; idFactory?: () => string },
): void {
  const desiredPositions = new Map<string, number>();
  for (const operation of proposal.operations) {
    if (operation.operation === "edit_item") {
      const item = plan.items.find((candidate) => candidate.id === operation.itemId)!;
      if (operation.title !== undefined) item.title = operation.title.trim();
      if (operation.outcome !== undefined) item.outcome = operation.outcome.trim();
      if (operation.definitionOfDone !== undefined) {
        item.definitionOfDone = operation.definitionOfDone?.trim() || undefined;
      }
      if (operation.position !== undefined) desiredPositions.set(item.id, operation.position);
    } else if (operation.operation === "set_owner") {
      plan.items.find((candidate) => candidate.id === operation.itemId)!.owner = operation.owner;
    } else if (operation.operation === "complete_item") {
      plan.items.find((candidate) => candidate.id === operation.itemId)!.decision = "completed";
    } else if (operation.operation === "create_item") {
      const id = options?.idFactory?.() ?? operation.clientId;
      const timestamp = options?.now ?? new Date().toISOString();
      plan.items.push({
        id,
        candidateId: id,
        taskId: id,
        outcomeKey: `assistant:${id}`,
        title: operation.title.trim(),
        outcome: operation.outcome.trim(),
        definitionOfDone: operation.definitionOfDone?.trim() || undefined,
        project: operation.project?.trim() || undefined,
        owner: operation.owner ?? "me",
        commitment: "ink",
        whyToday: "Added during Morning Arrival.",
        priority: operation.priority ?? "high",
        sourceRefs: [{
          sourceType: "decision",
          recordId: id,
          sourceUpdatedAt: timestamp,
          refreshedAt: timestamp,
          freshness: "current",
          supports: ["commitment", "priority"],
        }],
        newestSourceRefreshAt: timestamp,
        conflicts: [],
        humanDecisionEventIds: [],
        rankReasons: ["accepted_today", `priority_${operation.priority ?? "high"}`],
        position: operation.position,
        decision: "preselected",
      });
      desiredPositions.set(id, operation.position);
    } else {
      const retained = new Map(
        plan.items
          .filter((item) => EDITABLE_DECISIONS.has(item.decision))
          .map((item) => [item.id, item]),
      );
      const resolved = plan.items.filter((item) => !EDITABLE_DECISIONS.has(item.decision));
      plan.items = [
        ...operation.orderedItemIds.map((id) => retained.get(id)!),
        ...resolved,
      ];
    }
  }
  if (desiredPositions.size > 0) {
    plan.items.sort((left, right) =>
      (EDITABLE_DECISIONS.has(left.decision) ? 0 : 1) -
        (EDITABLE_DECISIONS.has(right.decision) ? 0 : 1) ||
      (desiredPositions.get(left.id) ?? left.position) -
        (desiredPositions.get(right.id) ?? right.position),
    );
  }
  plan.items.forEach((item, position) => {
    item.position = position;
  });
}
