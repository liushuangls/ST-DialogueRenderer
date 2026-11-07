import { getContext } from '../../../extensions.js';
import { createExtension } from "./src/extension.js?v=2.1.0";

const extension = createExtension({ getContext });
extension.start();

export async function onDisable() {
  await extension.dispose();
}
