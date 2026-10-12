// Preloaded with `node --import` by the plain-node entry tests. Pi supplies these packages
// only to code it loads itself, and `pi install` omits them from the package tree. The
// synchronous resolve hook makes them unresolvable no matter which node_modules exist on
// disk, so a test process sees the same package graph as an installed workflow server.
import { registerHooks } from "node:module";

export const BLOCKED_HOST_PACKAGE_MARKER = "PI_WORKFLOWS_TEST_BLOCKED_PI_PACKAGE";

const HOST_PACKAGE =
  /^(?:@earendil-works\/pi-(?:ai|agent-core|coding-agent|tui)|@mariozechner\/pi-[\w.-]+|typebox|@sinclair\/typebox)(?:\/|$)/u;

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (HOST_PACKAGE.test(specifier)) {
      const error = new Error(
        `${BLOCKED_HOST_PACKAGE_MARKER} ${specifier} imported from ${context.parentURL ?? "the entry"}`,
      );
      Object.assign(error, { code: "ERR_MODULE_NOT_FOUND" });
      throw error;
    }
    return nextResolve(specifier, context);
  },
});
