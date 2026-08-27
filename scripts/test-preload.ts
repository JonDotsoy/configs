/**
 * `configs.spec.ts` uses `declare const configs: configs;` instead of importing the value — this
 * preload supplies the real `globalThis.configs` it expects to find in scope.
 */
import { configs } from "../src/configs";

(globalThis as unknown as { configs: typeof configs }).configs = configs;
