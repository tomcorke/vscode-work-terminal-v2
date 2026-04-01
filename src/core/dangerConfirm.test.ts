import { describe, expect, it, vi, beforeEach } from "vitest";

const mockShowWarningMessage = vi.fn();

vi.mock("vscode", () => ({
  window: {
    showWarningMessage: (...args: unknown[]) => mockShowWarningMessage(...args),
  },
}));

import { dangerConfirm } from "./dangerConfirm";

describe("dangerConfirm", () => {
  beforeEach(() => {
    mockShowWarningMessage.mockReset();
  });

  it("returns true when user clicks Confirm", async () => {
    mockShowWarningMessage.mockResolvedValue("Confirm");
    const result = await dangerConfirm("Delete this item");
    expect(result).toBe(true);
    expect(mockShowWarningMessage).toHaveBeenCalledWith(
      'Are you sure you want to: Delete this item?',
      { modal: true },
      "Confirm",
    );
  });

  it("returns false when user cancels", async () => {
    mockShowWarningMessage.mockResolvedValue(undefined);
    const result = await dangerConfirm("Delete this item");
    expect(result).toBe(false);
  });

  it("returns false when user dismisses the dialog", async () => {
    mockShowWarningMessage.mockResolvedValue(undefined);
    const result = await dangerConfirm("Done & Close Sessions");
    expect(result).toBe(false);
  });
});
