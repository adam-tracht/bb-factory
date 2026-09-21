import { describe, expect, it, vi } from "vitest";

import {
  probeTasksAvailability,
  TasksClient,
  TasksIntegrationError,
} from "../src/tasks/index.js";

const project = {
  id: "project-1",
  name: "Factory",
  prefix: "FAC",
  color: "#123456",
  linkedBbProjectId: null,
};

describe("Tasks adapter", () => {
  it("does not call Tasks when the integration is disabled", async () => {
    const callRpc = vi.fn();
    const client = new TasksClient(callRpc as never, "disabled");

    await expect(client.listProjects()).rejects.toMatchObject({
      code: "tasks_unavailable",
    });
    expect(callRpc).not.toHaveBeenCalled();
    await expect(probeTasksAvailability(client)).resolves.toEqual({
      enabled: false,
      status: "disabled-or-unavailable",
      message: "Tasks integration is disabled in Factory settings.",
    });
    expect(callRpc).not.toHaveBeenCalled();
  });

  it("accepts additive fields in Tasks responses", async () => {
    const callRpc = vi.fn().mockResolvedValue({
      projects: [{ ...project, owner: { id: "person-1" } }],
      serverRevision: "rev-4",
    });
    const client = new TasksClient(callRpc as never);

    await expect(client.listProjects()).resolves.toEqual([
      { ...project, owner: { id: "person-1" } },
    ]);
    expect(callRpc).toHaveBeenCalledWith(expect.objectContaining({
      pluginId: "tasks",
      method: "listProjects",
      input: {},
    }));
  });

  it("classifies only anchored unavailable and incompatible RPC failures", async () => {
    const unavailableRpc = vi.fn().mockRejectedValue(new Error("HTTP 404 no rpc method: listProjects"));
    const unavailableClient = new TasksClient(unavailableRpc as never);
    await expect(unavailableClient.listProjects()).rejects.toMatchObject({
      code: "tasks_unavailable",
    });

    const inputValidationRpc = vi.fn().mockRejectedValue({
      status: 400,
      body: { message: "rpc input validation: expected an object" },
    });
    const inputValidationClient = new TasksClient(inputValidationRpc as never);
    await expect(inputValidationClient.getTask("task-1")).rejects.toMatchObject({
      code: "tasks_contract_incompatible",
    });

    const pluginUnavailableRpc = vi.fn().mockRejectedValue(new Error("Tasks plugin not running"));
    const pluginUnavailableClient = new TasksClient(pluginUnavailableRpc as never);
    await expect(pluginUnavailableClient.listProjects()).rejects.toMatchObject({
      code: "tasks_unavailable",
    });

    const incompatibleRpc = vi.fn().mockResolvedValue({ projects: [{ id: "missing" }] });
    const incompatibleClient = new TasksClient(incompatibleRpc as never);
    await expect(incompatibleClient.listProjects()).rejects.toMatchObject({
      code: "tasks_contract_incompatible",
    });

    const taskIdWith404Rpc = vi.fn().mockRejectedValue(new Error("failed to load task task-404"));
    const taskIdWith404Client = new TasksClient(taskIdWith404Rpc as never);
    await expect(taskIdWith404Client.getTask("task-404")).rejects.toMatchObject({
      code: "tasks_rpc_failed",
    });
  });

  it("reports an available Tasks plugin through the health probe", async () => {
    const callRpc = vi.fn().mockResolvedValue({ projects: [project] });
    const availability = await probeTasksAvailability(new TasksClient(callRpc as never));

    expect(availability).toEqual({
      enabled: true,
      status: "available",
      message: "Tasks is available.",
    });
  });

  it("preserves classified errors from the injected RPC", async () => {
    const error = new TasksIntegrationError("tasks_rpc_failed", "network down");
    const callRpc = vi.fn().mockRejectedValue(error);
    const client = new TasksClient(callRpc as never);

    await expect(client.listProjects()).rejects.toBe(error);
  });
});
