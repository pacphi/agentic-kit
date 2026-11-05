import assert from "node:assert/strict";
import { describe, it } from "node:test";

describe("footprint projection", () => {
  it("handles project-without-projectId edge case gracefully", () => {
    const mockInventory = [
      { id: "item1", scope: "project", projectId: undefined, type: "rule" },
      { id: "item2", scope: "project", projectId: "proj-123", type: "plugin" },
      { id: "item3", scope: "global", type: "mcp" }
    ];

    const unlinkedProjectItems = mockInventory.filter(
      (item) => item.scope === "project" && !item.projectId
    );

    assert.equal(unlinkedProjectItems.length, 1);
    assert.equal(unlinkedProjectItems[0].id, "item1");
  });
});
