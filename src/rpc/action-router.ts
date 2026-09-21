import {
  bbInteractionActionRequestSchema,
  provisionCheckoutActionRequestSchema,
  repositoryActionRequestSchema,
  revisionFreeActionRequestSchema,
  scaffoldProtocolActionRequestSchema,
  tasksActionRequestSchema,
  factoryActionResultSchema,
  type FactoryActionResult,
  type InvalidationEvent,
  type SettingsMutationResult,
} from "../contracts.js";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { actionError } from "../actions/results.js";
import { errorMessage } from "../errors.js";
import type { FactoryComposition } from "../services/action-composition.js";
import { resolveRepositoryProject } from "../services/repository-quickstart.js";
import { createSettingsMutationHandlers } from "../services/settings-mutations.js";
import type { FactoryReadRpcHandlers } from "./read-router.js";
import { createFactoryReadRpcHandlers } from "./read-router.js";

/**
 * The full factory RPC surface: the P1 read routes plus the guarded P2
 * action route. Revision-free actions go to the read-only executor;
 * repository actions go to the repository executor; BB interaction and
 * lifecycle actions go to the interaction executor.
 */
export function createFactoryRpcHandlers(
  getComposition: () => FactoryComposition,
  publish: (event: InvalidationEvent) => void,
  options: {
    applySettings?: (values: Record<string, string | number | boolean | null>) => Promise<void>;
    sdk?: BbPluginApi["sdk"];
  } = {},
): FactoryReadRpcHandlers {
  const read = createFactoryReadRpcHandlers(getComposition);
  const mutations = options.applySettings && options.sdk
    ? createSettingsMutationHandlers({
        getSettings: () => getComposition().settings,
        getComposition,
        applySettings: options.applySettings,
        sdk: options.sdk,
      })
    : null;
  const mutationsUnavailable = (): SettingsMutationResult => ({
    ok: false,
    error: {
      category: "unsupported",
      message: "Settings writes are not available in this runtime.",
    },
  });
  return {
    ...read,
    async factory_update_settings(input) {
      return mutations ? mutations.factory_update_settings(input) : mutationsUnavailable();
    },
    async factory_update_repository(input) {
      return mutations ? mutations.factory_update_repository(input) : mutationsUnavailable();
    },
    async factory_add_repository(input) {
      return mutations ? mutations.factory_add_repository(input) : mutationsUnavailable();
    },
    async factory_registry_options() {
      return getComposition().listRegistryOptions();
    },
    async factory_resolve_project(input) {
      // projects.create can run here, so this wizard call is not a read route.
      return resolveRepositoryProject(getComposition().sdk, input);
    },
    async factory_action(input) {
      const composition = getComposition();
      const revisionFree = revisionFreeActionRequestSchema.safeParse(input);
      if (revisionFree.success) {
        const entry = composition.getRepositoryEntry(revisionFree.data.repositoryKey);
        if (!entry) {
          return actionError("not-found", `Repository '${revisionFree.data.repositoryKey}' is not configured.`, revisionFree.data.idempotencyKey);
        }
        return composition.readOnlyActionExecutor.execute(revisionFree.data);
      }

      const tasksAction = tasksActionRequestSchema.safeParse(input);
      const repositoryAction = repositoryActionRequestSchema.safeParse(input);
      const scaffoldAction = tasksAction.success || repositoryAction.success ? null : scaffoldProtocolActionRequestSchema.safeParse(input);
      const provisionAction = tasksAction.success || repositoryAction.success || scaffoldAction?.success
        ? null
        : provisionCheckoutActionRequestSchema.safeParse(input);
      let request;
      let execute: () => Promise<FactoryActionResult>;
      if (tasksAction.success) {
        request = tasksAction.data;
        const valid = tasksAction.data;
        execute = () => composition.tasksActionExecutor.execute(valid);
      } else if (repositoryAction.success) {
        request = repositoryAction.data;
        const valid = repositoryAction.data;
        execute = () => composition.repositoryActionExecutor.execute(valid);
      } else if (scaffoldAction !== null && scaffoldAction.success) {
        request = scaffoldAction.data;
        const valid = scaffoldAction.data;
        execute = () => composition.scaffoldProtocolActionExecutor.execute(valid);
      } else if (provisionAction !== null && provisionAction.success) {
        request = provisionAction.data;
        const valid = provisionAction.data;
        execute = () => composition.provisionCheckoutActionExecutor.execute(valid);
      } else {
        const bbAction = bbInteractionActionRequestSchema.safeParse(input);
        if (!bbAction.success) {
          return actionError(
            "invalid-input",
            `Invalid factory action request: ${repositoryAction.error.issues[0]?.message ?? "schema mismatch"}`,
          );
        }
        request = bbAction.data;
        const valid = bbAction.data;
        execute = () => composition.bbInteractionActionExecutor.execute(valid);
      }
      const entry = composition.getRepositoryEntry(request.repositoryKey);
      // A provision request with an explicit host + root target runs before
      // the repository is registered, so it does not need a configured entry.
      const provisionHasExplicitTarget =
        request.action.kind === "provision-checkout" && request.action.hostId !== undefined;
      if (!entry && !provisionHasExplicitTarget) {
        return actionError("not-found", `Repository '${request.repositoryKey}' is not configured.`, request.idempotencyKey);
      }

      let result: FactoryActionResult;
      try {
        result = await execute();
      } catch (error) {
        return actionError(
          "internal",
          `The action executor failed: ${errorMessage(error)}`,
          request.idempotencyKey,
        );
      }
      const validated = factoryActionResultSchema.safeParse(result);
      if (!validated.success) {
        return actionError(
          "internal",
          `The action executor returned a malformed result: ${validated.error.issues[0]?.message ?? "schema mismatch"}`,
          request.idempotencyKey,
        );
      }
      if (validated.data.ok && validated.data.result.status !== "preview") {
        publish({
          channel: "factory",
          kind: "repository.changed",
          repositoryKey: request.repositoryKey,
          revision: validated.data.revision,
          reason: `Factory action '${request.action.kind}' changed state.`,
          durableReloadRequired: true,
        });
      }
      return validated.data;
    },
  };
}
